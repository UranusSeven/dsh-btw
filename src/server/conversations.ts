import type { SideResult } from '../shared'
import { MAX_ACTIVE_TURNS, MAX_TURNS_PER_BUBBLE } from '../limits'
import { translate, type BtwLocale, type BtwTranslate } from '../locales'
import { sanitizeModelAnswer } from './jobs'

/**
 * 一轮旁问的生命周期结果。
 *
 * 宿主 0.2.1 的 continuable 子代理在「一轮答完且没有排队输入」后会自然结算并
 * 释放激活名额；因此本注册表不假设轮次结束后仍有驻留 Agent。追问统一走
 * `subagents.prompt` / 内部 `deliverSubagentPrompt` 的冷恢复路径，childId 是
 * 唯一需要跨轮保留的宿主句柄。
 */
export interface ConversationHandle {
  /** 中断并释放整条会话，同时释放插件侧的 guard/label 资源。 */
  dispose(): Promise<void>
  /** 只释放宿主激活名额（保留 childId 供冷恢复），不动插件侧 guard/label。 */
  release?(): Promise<void>
}

export interface ConversationStartInput {
  parent: unknown
  parentSessionId: string
  childId: string
  prompt: string
  signal: AbortSignal
  locale: BtwLocale
}

export interface ConversationDeliverInput {
  parent: unknown
  parentSessionId: string
  childId: string
  text: string
  signal: AbortSignal
}

export interface ConversationHost {
  /** 订阅宿主的 session/event；回调必须同步、不能抛错。 */
  watch(listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  start(input: ConversationStartInput): Promise<ConversationHandle>
  deliver(input: ConversationDeliverInput): Promise<void>
  interrupt(parentSessionId: string, childId: string): void
  /** 可选：释放冷恢复后的驻留激活（宿主 drainChildren）。 */
  drain?(parent: unknown, childId: string): Promise<void>
  newChildId(): string
}

export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

export interface SessionLike {
  readonly id?: string
  readonly header?: { readonly id?: string }
}

interface TurnReason {
  kind: string
  error?: { message?: string }
}

interface TurnOutcome {
  reason: TurnReason
  text: string
}

interface Waiter {
  readonly events: SessionEventLike[]
  readonly startedTurns: Set<number>
  readonly resolve: (outcome: TurnOutcome) => void
  readonly promise: Promise<TurnOutcome>
  readonly signal?: AbortSignal
  onAbort?: () => void
  timer?: ReturnType<typeof setTimeout>
}

interface Conversation {
  readonly key: string
  readonly bubbleId: string
  readonly parentSessionId: string
  readonly childId: string
  readonly locale: BtwLocale
  turns: number
  results: Map<number, SideResult>
  busy: boolean
  closing: boolean
  started: boolean
  current?: { turn: number; promise: Promise<SideResult> }
  dispose?: () => Promise<void>
  release?: () => Promise<void>
  idleTimer?: ReturnType<typeof setTimeout>
}

export interface ConversationOptions {
  maxActive?: number
  maxTurns?: number
  maxPerParent?: number
  timeoutMs?: number
  cleanupTimeoutMs?: number
  /** 一轮结束后保留宿主激活的时长；0 表示依赖宿主自然结算。 */
  idleTtlMs?: number
  onError?: (error: Error) => void
  /** 卸载后所有迟到的启动也释放完毕时调用；用于注销根 guard。 */
  onIdle?: () => void | Promise<void>
}

export const DEFAULT_TURN_TIMEOUT_MS = 1_800_000

const CONVERSATION_LIMIT = 20

const failure = (text: string, partial?: string): SideResult => ({
  kind: 'error',
  text,
  ...(partial === undefined ? {} : { partial }),
})

const keyOf = (parentSessionId: string, bubbleId: string): string => JSON.stringify([parentSessionId, bubbleId])

function sessionIdOf(session: SessionLike): string | undefined {
  const id = session.header?.id ?? session.id
  return typeof id === 'string' ? id : undefined
}

function streamText(stream: unknown): string {
  if (!Array.isArray(stream)) return ''
  let text = ''
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    const item = record as { type?: unknown; texts?: unknown; chunk?: { type?: unknown; text?: unknown } }
    if (item.type === 'text-chunks' && Array.isArray(item.texts)) {
      text += item.texts.filter((piece): piece is string => typeof piece === 'string').join('')
    } else if (item.type === 'chunk' && item.chunk?.type === 'text-delta' && typeof item.chunk.text === 'string') {
      text += item.chunk.text
    }
  }
  return text
}

/**
 * 与宿主 `finalAssistantOutput` 等价的选择规则：最后一条非空 assistant
 * message 优先，没有 message 时回退到累计的流文本（覆盖取消、截断等场景）。
 */
function outputText(events: readonly SessionEventLike[], startedTurns: ReadonlySet<number>): string {
  let message: string | undefined
  const partial: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const data = event.data as { turn?: unknown; message?: { content?: unknown }; stream?: unknown } | undefined
    if (typeof data?.turn === 'number' && startedTurns.size > 0 && !startedTurns.has(data.turn)) continue
    if (event.type === 'assistant/message') {
      const content = data?.message?.content
      if (Array.isArray(content) && content.length > 0) {
        message = content
          .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
          .map(block => typeof block.text === 'string' ? block.text : '')
          .join('')
      }
    }
    partial.push(streamText(data?.stream))
  }
  return message ?? partial.join('')
}

function reasonOf(event: SessionEventLike): TurnReason {
  const data = event.data as { reason?: unknown } | undefined
  const reason = data?.reason
  if (reason && typeof reason === 'object' && typeof (reason as { kind?: unknown }).kind === 'string') {
    return reason as TurnReason
  }
  return { kind: 'completed' }
}

function reasonDetail(reason: TurnReason): string {
  if (reason.kind === 'error' && typeof reason.error?.message === 'string') return reason.error.message
  return reason.kind
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 多轮旁问注册表：一个气泡对应一个 continuable 子会话。
 *
 * - 轮次输出通过 `session/event` 收敛，不依赖 `activation.result`（后者只在
 *   激活释放后才结算，无法支撑轮次间等待）。
 * - `turn` 由客户端递增，成功的轮次结果按 turn 缓存，网络重试直接回放。
 * - 正在进行的同一 turn 被重复提交时返回同一个 Promise，不重复投递。
 */
export class ConversationRegistry {
  private readonly entries = new Map<string, Conversation>()
  private readonly byChild = new Map<string, Conversation>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly retired = new Map<string, number>()
  /** 关闭后的 childId 仍保留一小段时间，用于过滤宿主迟到的 subagent-settled 通知。 */
  private readonly retiredChildren = new Map<string, { parentSessionId: string; at: number }>()
  private readonly stopWatch: () => void
  private readonly starting = new Set<Promise<SideResult>>()
  private active = 0
  private disposed = false

  constructor(private readonly host: ConversationHost, private readonly options: ConversationOptions = {}) {
    this.stopWatch = host.watch((session, event) => this.observe(session, event))
  }

  /** 条目 + 仍在启动中的轮次；卸载时用来等迟到句柄。 */
  get size(): number { return this.entries.size + this.starting.size }
  get activeSize(): number { return this.active }

  /** 该 childId 是否属于本插件；用于识别并丢弃宿主发给主会话的结算通知。 */
  parentOfChild(childId: string): string | undefined {
    return this.byChild.get(childId)?.parentSessionId ?? this.retiredChildren.get(childId)?.parentSessionId
  }

  async start(parentSessionId: string, bubbleId: string, prompt: string, signal: AbortSignal, parent: unknown, locale: BtwLocale = 'zh'): Promise<SideResult> {
    const t = translate(locale)
    this.prune()
    if (this.disposed) return failure(t('error.stopped'))
    const key = keyOf(parentSessionId, bubbleId)
    if (this.entries.has(key) || this.retired.has(key)) return failure(t('error.duplicate'))
    const maxPerParent = this.options.maxPerParent ?? CONVERSATION_LIMIT
    if ([...this.entries.values()].filter(entry => entry.parentSessionId === parentSessionId).length >= maxPerParent) return failure(t('error.bubbleCapacity'))
    if (this.active >= (this.options.maxActive ?? MAX_ACTIVE_TURNS)) return failure(t('error.capacity'))

    const childId = this.host.newChildId()
    const entry: Conversation = {
      key,
      bubbleId,
      parentSessionId,
      childId,
      locale,
      turns: 0,
      results: new Map(),
      busy: false,
      closing: false,
      started: false,
    }
    this.entries.set(key, entry)
    this.byChild.set(childId, entry)
    const operation = this.runTurn(entry, 1, prompt, signal, locale, async () => {
      const handle = await this.host.start({ parent, parentSessionId, childId, prompt, signal, locale })
      entry.dispose = handle.dispose
      entry.release = handle.release
      // 关闭可能先于启动完成到达；此时条目已被移除，迟到的激活必须就地释放。
      if (entry.closing || this.entries.get(entry.key) !== entry) {
        entry.dispose = undefined
        entry.release = undefined
        await handle.dispose().catch(error => this.report(error))
        throw new Error(t('error.cancelled'))
      }
    })
    this.starting.add(operation)
    const settle = () => {
      this.starting.delete(operation)
      // 延后一拍：start() 的 await 续体还要在本轮失败时 remove(entry)，
      // 立刻检查会把「条目尚未删除」误判成仍有工作。
      queueMicrotask(() => {
        if (this.disposed && this.size === 0) void Promise.resolve().then(() => this.options.onIdle?.()).catch(error => this.report(error))
      })
    }
    void operation.then(settle, settle)
    const result = await operation
    const started = entry.started
    if (!started) this.remove(entry)
    // 启动就失败（没有子会话）时不宣告多轮，客户端才不会显示一个必然失败的追问框。
    return { ...result, ...(started ? { multiturn: true } : {}) }
  }

  async reply(parentSessionId: string, bubbleId: string, turn: number, text: string, signal: AbortSignal, parent: unknown, locale: BtwLocale = 'zh'): Promise<SideResult> {
    const t = translate(locale)
    this.prune()
    if (this.disposed) return failure(t('error.stopped'))
    const entry = this.entries.get(keyOf(parentSessionId, bubbleId))
    if (!entry || entry.closing) return failure(t('error.conversation'))
    const cached = entry.results.get(turn)
    if (cached) return { ...cached, multiturn: true }
    if (entry.busy) {
      if (entry.current?.turn === turn) return entry.current.promise
      return failure(t('error.busy'))
    }
    if (turn !== entry.turns + 1) return failure(t('error.turn'))
    if (turn > (this.options.maxTurns ?? MAX_TURNS_PER_BUBBLE)) return failure(t('bubble.limit.turns', { max: this.options.maxTurns ?? MAX_TURNS_PER_BUBBLE }))
    if (this.active >= (this.options.maxActive ?? MAX_ACTIVE_TURNS)) return failure(t('error.capacity'))
    const result = await this.runTurn(entry, turn, text, signal, locale, () => this.host.deliver({ parent, parentSessionId, childId: entry.childId, text, signal }))
    return { ...result, multiturn: true }
  }

  /** 只中断当前轮；条目与已完成轮次保留，客户端可以立即重试。 */
  stop(parentSessionId: string, bubbleId: string): SideResult {
    const entry = this.entries.get(keyOf(parentSessionId, bubbleId))
    if (!entry || this.disposed) return { kind: 'success', text: '' }
    if (entry.busy) {
      this.interrupt(entry)
      this.cancelWaiter(entry)
    }
    return { kind: 'success', text: '' }
  }

  /** 关闭是终态：中断、释放激活、删除条目，并留下 5 分钟墓碑挡住迟到投递。 */
  async close(parentSessionId: string, bubbleId: string, parent?: unknown): Promise<SideResult> {
    const key = keyOf(parentSessionId, bubbleId)
    this.retire(key)
    const entry = this.entries.get(key)
    if (!entry) return { kind: 'success', text: '' }
    const t = translate(entry.locale)
    if (entry.closing) return failure(t('error.cleanup', { detail: '' }).trim())
    entry.closing = true
    this.clearIdle(entry)
    try {
      this.interrupt(entry)
      this.cancelWaiter(entry)
      // 冷恢复后的激活不归 entry.dispose 管；先尝试按父会话释放驻留子代理。
      if (this.host.drain && parent !== undefined) {
        try { await this.bounded(this.host.drain(parent, entry.childId), t('error.cleanupTimeout')) }
        catch (error) { this.report(error) }
      }
      if (entry.dispose) await this.bounded(entry.dispose(), t('error.cleanupTimeout'))
      this.remove(entry)
      return { kind: 'success', text: '' }
    } catch (error) {
      entry.closing = false
      this.report(error)
      const detail = error instanceof Error ? error.message : String(error)
      return failure(t('error.cleanup', { detail: detail ? ` ${detail}` : '' }))
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopWatch()
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.byChild.clear()
    for (const waiter of this.waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer)
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    for (const [childId, waiter] of [...this.waiters]) {
      this.finishWaiter(childId, waiter, { reason: { kind: 'aborted' }, text: outputText(waiter.events, waiter.startedTurns) })
    }
    await Promise.all(entries.map(async entry => {
      this.interrupt(entry)
      this.cancelWaiter(entry)
      try {
        if (entry.dispose) await this.bounded(entry.dispose(), translate(entry.locale)('error.cleanupTimeout'))
      } catch (error) { this.report(error) }
    }))
    if (this.size === 0) await Promise.resolve(this.options.onIdle?.()).catch(error => this.report(error))
  }

  private async runTurn(
    entry: Conversation,
    turn: number,
    text: string,
    signal: AbortSignal,
    locale: BtwLocale,
    action: () => Promise<void>,
  ): Promise<SideResult> {
    const t = translate(locale)
    if (entry.busy) return failure(t('error.busy'))
    if (entry.closing) return failure(t('error.conversation'))
    this.clearIdle(entry)
    const waiter = this.openWaiter(entry, signal)
    entry.busy = true
    this.active += 1
    const promise = this.executeTurn(entry, turn, signal, t, action, waiter)
    entry.current = { turn, promise }
    void promise.then(settleCurrent, settleCurrent)
    return promise
    function settleCurrent(): void {
      if (entry.current?.promise === promise) entry.current = undefined
    }
  }

  private async executeTurn(
    entry: Conversation,
    turn: number,
    signal: AbortSignal,
    t: BtwTranslate,
    action: () => Promise<void>,
    waiter: Waiter,
  ): Promise<SideResult> {
    entry.busy = true
    try {
      signal.throwIfAborted()
      await action()
      entry.started = true
      const outcome = await waiter.promise
      const answer = sanitizeModelAnswer(outcome.text)
      if (outcome.reason.kind === 'completed') {
        if (!answer) return failure(t('error.noText'))
        const result: SideResult = { kind: 'success', text: answer }
        entry.turns = Math.max(entry.turns, turn)
        entry.results.set(turn, result)
        return result
      }
      if (outcome.reason.kind === 'aborted' || outcome.reason.kind === 'interrupted') return failure(t('bubble.turn.cancelled'), answer || undefined)
      if (outcome.reason.kind === 'timeout') return failure(t('error.timeout'), answer || undefined)
      // 部分答案通过 `partial` 单独返回，客户端会渲染它；不再把同一段文本
      // 重复塞进错误文案。
      return failure(t('error.incomplete', { reason: reasonDetail(outcome.reason), detail: '' }), answer || undefined)
    } catch (error) {
      if (signal.aborted) return failure(t('error.cancelled'), outputText(waiter.events, waiter.startedTurns) || undefined)
      return this.failureFor(error, t)
    } finally {
      this.closeWaiter(entry.childId)
      entry.busy = false
      this.active = Math.max(0, this.active - 1)
      if (entry.started && !entry.closing && this.entries.get(entry.key) === entry) this.scheduleIdle(entry)
    }
  }

  private openWaiter(entry: Conversation, signal: AbortSignal): Waiter {
    let resolve!: (outcome: TurnOutcome) => void
    const promise = new Promise<TurnOutcome>(yes => { resolve = yes })
    const waiter: Waiter = {
      events: [],
      startedTurns: new Set(),
      promise,
      resolve,
      signal,
    }
    // 先登记再挂取消监听：已中止的 signal 会同步结算，此时 waiter 必须已在表里。
    this.waiters.set(entry.childId, waiter)
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        this.interrupt(entry)
        this.finishWaiter(entry.childId, waiter, { reason: { kind: 'timeout' }, text: outputText(waiter.events, waiter.startedTurns) })
      }, timeoutMs)
      waiter.timer.unref?.()
    }
    const onAbort = () => {
      this.interrupt(entry)
      this.finishWaiter(entry.childId, waiter, { reason: { kind: 'aborted' }, text: outputText(waiter.events, waiter.startedTurns) })
    }
    waiter.onAbort = onAbort
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    return waiter
  }

  private finishWaiter(childId: string, waiter: Waiter, outcome: TurnOutcome): void {
    if (this.waiters.get(childId) !== waiter) return
    this.waiters.delete(childId)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(outcome)
  }

  private closeWaiter(childId: string): void {
    const waiter = this.waiters.get(childId)
    if (!waiter) return
    this.waiters.delete(childId)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  }

  private observe(session: SessionLike, event: SessionEventLike): void {
    const childId = sessionIdOf(session)
    if (!childId) return
    const waiter = this.waiters.get(childId)
    if (!waiter) return
    if (event.type === 'turn/start') {
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      if (typeof turn === 'number') waiter.startedTurns.add(turn)
      waiter.events.push(event)
      return
    }
    if (event.type === 'turn/end') {
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      // 过滤上一轮停止后迟到的 turn/end：只有本 waiter 见过的 turn/start
      // 才能结算，避免一次停止把紧接着的重试误判为已完成。
      if (typeof turn === 'number' && !waiter.startedTurns.has(turn)) return
      const reason = reasonOf(event)
      // `forked` 只出现在 fork 种子尾部（被复制前缀的开放轮收尾），不是本轮的结束；
      // 误把它当结算会立刻返回空答案。
      if (reason.kind === 'forked') return
      waiter.events.push(event)
      this.finishWaiter(childId, waiter, { reason, text: outputText(waiter.events, waiter.startedTurns) })
      return
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') waiter.events.push(event)
  }

  /** 立即结算当前等待者；不依赖模型在中断后补发 turn/end。 */
  private cancelWaiter(entry: Conversation): void {
    const waiter = this.waiters.get(entry.childId)
    if (!waiter) return
    this.finishWaiter(entry.childId, waiter, { reason: { kind: 'aborted' }, text: outputText(waiter.events, waiter.startedTurns) })
  }

  private interrupt(entry: Conversation): void {
    try { this.host.interrupt(entry.parentSessionId, entry.childId) }
    catch (error) { this.report(error) }
  }

  private failureFor(error: unknown, t: BtwTranslate): SideResult {
    const code = codeOf(error)
    if (code === 'ACTIVATION_LIMIT_REACHED' || code === 'DELIVERY_UNAVAILABLE' || /capacity/i.test(code ?? '')) {
      return failure(t('error.capacityChild'))
    }
    if (code === 'NOT_RESUMABLE' || code === 'DUPLICATE_CHILD') return failure(t('bubble.expired'))
    if (code === 'UNAUTHORIZED' || code === 'PARENT_UNAVAILABLE' || code === 'ACTIVATION_CLOSING' || code === 'INPUT_CLOSED') {
      return failure(t('error.conversation'))
    }
    return failure(error instanceof Error ? error.message : String(error))
  }

  private remove(entry: Conversation): void {
    this.clearIdle(entry)
    this.entries.delete(entry.key)
    this.byChild.delete(entry.childId)
    this.retiredChildren.set(entry.childId, { parentSessionId: entry.parentSessionId, at: Date.now() })
    this.prune()
  }

  /** 一轮结束后释放宿主激活名额，但保留 childId 与插件 guard，追问走冷恢复。 */
  private scheduleIdle(entry: Conversation): void {
    this.clearIdle(entry)
    const ttl = this.options.idleTtlMs ?? 300_000
    if (ttl <= 0 || !entry.release) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (entry.busy || entry.closing || this.entries.get(entry.key) !== entry) return
      const release = entry.release ?? entry.dispose
      if (!release) return
      void Promise.resolve().then(() => release()).catch(error => this.report(error))
    }, ttl)
    entry.idleTimer.unref?.()
  }

  private clearIdle(entry: Conversation): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  private retire(key: string): void {
    this.retired.set(key, Date.now())
    this.prune()
  }

  private prune(): void {
    for (const [key, time] of this.retired) {
      if (Date.now() - time > 300_000 || this.retired.size > 1_000) this.retired.delete(key)
    }
    for (const [key, value] of this.retiredChildren) {
      if (Date.now() - value.at > 300_000 || this.retiredChildren.size > 1_000) this.retiredChildren.delete(key)
    }
  }

  private async bounded(work: Promise<void>, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), this.options.cleanupTimeoutMs ?? 5_000)
      timer.unref?.()
    })
    try { await Promise.race([work, timeout]) }
    finally { clearTimeout(timer) }
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))) }
    catch (nested) { console.error(nested) }
  }
}
