import { MAX_QUESTION_LENGTH, MAX_REFERENCE_LENGTH, type SideResult } from '../shared'
import { MAX_TURNS_PER_BUBBLE } from '../limits'
import { translate, type BtwTranslate } from '../locales'

const MAX_BUBBLES_PER_SESSION = 20
const STORAGE_PREFIX = 'btw.bubbles.v1.'
const STORAGE_VERSION = 1

export type TurnPhase = 'answering' | 'done' | 'error'

/** 气泡内的一轮问答；追问复用同一子会话，历史按轮次累积。 */
export interface Turn {
  question: string
  reference?: string
  answer: string
  phase: TurnPhase
  error?: string
  cancelled?: boolean
}

export interface Bubble {
  id: string
  sessionId: string
  question: string
  reference?: string
  answer: string
  phase: 'answering' | 'done' | 'error' | 'partial' | 'closing'
  error?: string
  closeFailed?: boolean
  turns?: Turn[]
  /** 从 localStorage 恢复的历史气泡；可在服务端会话仍有效时继续追问。 */
  restored?: boolean
}

export interface SideTransport {
  run(session: string, id: string, question: string, signal: AbortSignal, reference?: string): Promise<SideResult>
  reply?(session: string, id: string, turn: number, text: string, signal: AbortSignal, reference?: string): Promise<SideResult>
  stop?(session: string, id: string): Promise<SideResult>
  /** 显式能力探测；旧服务端没有该命令时返回 false，追问框自动隐藏。 */
  probe?(session: string): Promise<boolean>
  close(session: string, id: string): Promise<SideResult>
}

/** 宿主在进入 handler 前明确拒绝启动；没有后台任务需要清理。 */
export class SideRequestNotStartedError extends Error {}

const lastTurn = (bubble: Bubble | undefined): Turn | undefined => bubble?.turns?.at(-1)

function mapLastTurn(turns: readonly Turn[] | undefined, patch: Partial<Turn>): Turn[] | undefined {
  if (!turns?.length) return turns as Turn[] | undefined
  const copy = turns.map(turn => ({ ...turn }))
  copy[copy.length - 1] = { ...copy[copy.length - 1]!, ...patch }
  return copy
}

function phaseOf(turn: Turn): Bubble['phase'] {
  if (turn.phase === 'answering') return 'answering'
  if (turn.cancelled) return 'partial'
  return turn.phase === 'error' ? 'error' : 'done'
}

/** 浏览器/测试环境的 localStorage；Node 的全局实现可能是空壳，优先取 window。 */
function browserStorage(): Storage | undefined {
  try {
    const candidate = typeof window !== 'undefined' ? window.localStorage : typeof localStorage !== 'undefined' ? localStorage : undefined
    return candidate && typeof candidate.getItem === 'function' ? candidate : undefined
  } catch { return undefined }
}

function bubblePhase(bubble: Bubble): Bubble['phase'] {
  return phaseOf(lastTurn(bubble) ?? { question: bubble.question, answer: bubble.answer, phase: bubble.phase === 'error' ? 'error' : bubble.phase === 'answering' ? 'answering' : 'done' })
}

/** 仅内存 UI 状态；关闭请求与答案返回按请求身份分别收敛。 */
export class BubbleStore {
  private snapshot: readonly Bubble[] = []
  private readonly listeners = new Set<() => void>()
  private readonly active = new Map<string, AbortController>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly notStarted = new Set<string>()
  private readonly runEnd = new Map<string, 'pending' | 'success' | 'not-started' | 'aborted' | 'failed'>()
  private readonly closeFenced = new Set<string>()
  private readonly admitting = new Set<string>()
  private readonly hydrated = new Set<string>()
  private readonly sessions = new Set<string>()
  private disposed = false
  private hydrating = false
  /** 服务端是否支持多轮；由 probe() 显式确认，默认乐观显示。 */
  private multiturn = true
  private probed = false
  private probing = false
  constructor(private readonly transport: SideTransport, private readonly t: BtwTranslate = translate()) {}
  getSnapshot = (): readonly Bubble[] => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  /** 宿主是否提供追问通道；旧宿主/旧客户端自动隐藏追问输入框。 */
  get supportsReply(): boolean { return this.multiturn && typeof this.transport.reply === 'function' }

  /**
   * CommandResult 只保留 kind/text，因此能力标记不能搭 btw-run 的返回顺风车。
   * Dock 挂载时调用一次隐藏命令；旧服务端不认识时翻译成 false。
   */
  async probe(sessionId: string): Promise<void> {
    if (this.probed || this.probing || !this.transport.probe) return
    this.probing = true
    try { this.multiturn = await this.transport.probe(sessionId) }
    catch { this.multiturn = false }
    finally {
      this.probing = false
      this.probed = true
      this.publish(this.snapshot)
    }
  }

  /** 返回已接收请求的标识；满额先等待旧气泡关闭，失败时拒绝且不发送新问题。 */
  async ask(sessionId: string, question: string, reference?: string): Promise<string> {
    if (this.disposed) throw new Error(this.t('error.stopped'))
    if (!question.trim()) throw new Error(this.t('error.empty'))
    if (question.length > MAX_QUESTION_LENGTH) throw new Error(this.t('error.length'))
    if (reference !== undefined && (!reference.trim() || reference.length > MAX_REFERENCE_LENGTH)) throw new Error(this.t('error.reference'))
    if (this.admitting.has(sessionId)) throw new Error(this.t('error.bubbleCapacity'))
    if (this.active.size >= 8) throw new Error(this.t('error.capacity'))
    this.sessions.add(sessionId)
    const sessionBubbles = this.snapshot.filter(item => item.sessionId === sessionId)
    if (sessionBubbles.length >= MAX_BUBBLES_PER_SESSION) {
      const oldest = sessionBubbles.find(item => !this.isActive(item.id) && !this.closing.has(item.id) && !item.closeFailed)
      if (!oldest) throw new Error(this.t('error.bubbleCapacity'))
      this.admitting.add(sessionId)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // 先确认关闭再接收；传输挂起时有界返回，后续关闭仍由原 Promise 接管。
        await Promise.race([this.close(oldest.id), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(this.t('error.bubbleCapacity'))), 5_000)
        })])
      } finally {
        clearTimeout(timer)
        this.admitting.delete(sessionId)
      }
    }
    if (this.disposed) throw new Error(this.t('error.stopped'))
    if (this.snapshot.filter(item => item.sessionId === sessionId).length >= MAX_BUBBLES_PER_SESSION) throw new Error(this.t('error.bubbleCapacity'))
    if (this.active.size >= 8) throw new Error(this.t('error.capacity'))
    const id = crypto.randomUUID()
    const controller = new AbortController()
    const turn: Turn = { question, ...(reference === undefined ? {} : { reference }), answer: '', phase: 'answering' }
    this.active.set(id, controller)
    this.runEnd.set(id, 'pending')
    this.publish([...this.snapshot, { id, sessionId, question, ...(reference === undefined ? {} : { reference }), answer: '', phase: 'answering', turns: [turn] }])
    void Promise.resolve().then(() => reference === undefined ? this.transport.run(sessionId, id, question, controller.signal) : this.transport.run(sessionId, id, question, controller.signal, reference)).then(result => {
      if (result.multiturn === true) this.multiturn = true
      if (result.kind === 'success') {
        this.runEnd.set(id, 'success')
        if (!this.snapshot.some(item => item.id === id)) return
        const failedClose = this.closeFenced.has(id) || Boolean(this.snapshot.find(item => item.id === id)?.closeFailed)
        this.completeTurn(id, result.text)
        this.update(id, { phase: failedClose ? 'error' : this.closing.has(id) ? 'closing' : 'done', answer: result.text, ...(failedClose ? {} : { error: undefined }) })
        return
      }
      if (controller.signal.aborted) {
        if (this.runEnd.get(id) === 'pending') this.runEnd.set(id, 'aborted')
        this.failTurn(id, this.t('bubble.turn.cancelled'), true)
        this.dropIfCloseCannotFinish(id)
        return
      }
      this.runEnd.set(id, 'failed')
      if (!this.closing.has(id)) {
        this.failTurn(id, result.text)
        this.update(id, { phase: 'error', answer: result.partial ?? '', error: result.text })
      }
    }).catch(error => {
      if (this.runEnd.get(id) === 'success') return
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof SideRequestNotStartedError && this.snapshot.some(item => item.id === id)) {
        this.runEnd.set(id, 'not-started')
        this.notStarted.add(id)
        if (this.closeFenced.has(id) || this.closing.has(id)) { this.remove(id); return }
        this.failTurn(id, message)
        this.update(id, { phase: 'error', error: message })
        return
      }
      if (controller.signal.aborted) {
        if (this.runEnd.get(id) === 'pending') this.runEnd.set(id, 'aborted')
        this.failTurn(id, this.t('bubble.turn.cancelled'), true)
        this.dropIfCloseCannotFinish(id)
        return
      }
      this.runEnd.set(id, 'failed')
      if (!this.closing.has(id)) {
        this.failTurn(id, message)
        this.update(id, { phase: 'error', error: message })
      }
    }).finally(() => { this.active.delete(id) })
    return id
  }

  /**
   * 向同一气泡投递追问。上一轮失败/取消时替换该轮（重试），否则追加新一轮。
   * 校验失败直接抛错；传输错误写进轮次状态，气泡保留可继续重试。
   */
  async reply(sessionId: string, id: string, text: string, reference?: string): Promise<number> {
    if (this.disposed) throw new Error(this.t('error.stopped'))
    if (!this.transport.reply) throw new Error(this.t('error.multiturnUnsupported'))
    if (!text.trim()) throw new Error(this.t('error.empty'))
    if (text.length > MAX_QUESTION_LENGTH) throw new Error(this.t('error.length'))
    if (reference !== undefined && (!reference.trim() || reference.length > MAX_REFERENCE_LENGTH)) throw new Error(this.t('error.reference'))
    const bubble = this.snapshot.find(item => item.id === id)
    if (!bubble) throw new Error(this.t('error.conversation'))
    if (bubble.phase === 'answering' || bubble.phase === 'closing') throw new Error(this.t('error.busy'))
    const turns = bubble.turns?.slice() ?? [{ question: bubble.question, answer: bubble.answer, phase: bubble.phase === 'error' ? 'error' as const : 'done' as const }]
    const previous = turns.at(-1)
    const retry = previous !== undefined && (previous.phase === 'error' || previous.cancelled)
    if (!retry && turns.length >= MAX_TURNS_PER_BUBBLE) throw new Error(this.t('bubble.limit.turns', { max: MAX_TURNS_PER_BUBBLE }))
    if (this.active.size >= 8) throw new Error(this.t('error.capacity'))
    const turnNumber = retry ? turns.length : turns.length + 1
    const turn: Turn = { question: text, ...(reference === undefined ? {} : { reference }), answer: '', phase: 'answering' }
    if (retry) turns[turns.length - 1] = turn
    else turns.push(turn)
    const controller = new AbortController()
    const key = `${id}:${turnNumber}`
    this.active.set(key, controller)
    this.update(id, { turns, answer: '', phase: 'answering', error: undefined })
    void Promise.resolve().then(() => this.transport.reply!(sessionId, id, turnNumber, text, controller.signal, reference)).then(result => {
      if (result.multiturn === true) this.multiturn = true
      if (!this.snapshot.some(item => item.id === id)) return
      if (result.kind === 'success') {
        this.completeTurn(id, result.text)
        this.update(id, { phase: 'done', answer: result.text, error: undefined })
        return
      }
      this.failTurn(id, result.text, controller.signal.aborted, result.partial)
      this.update(id, { phase: controller.signal.aborted ? 'partial' : 'error', answer: result.partial ?? '', error: result.text })
    }).catch(error => {
      if (!this.snapshot.some(item => item.id === id)) return
      if (controller.signal.aborted) {
        this.failTurn(id, this.t('bubble.turn.cancelled'), true)
        this.update(id, { phase: 'partial' })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.failTurn(id, message)
      this.update(id, { phase: 'error', error: message })
    }).finally(() => { this.active.delete(key) })
    return turnNumber
  }

  /** 只停止当前轮；气泡与历史保留，可以立即重试。 */
  stop(id: string): void {
    const bubble = this.snapshot.find(item => item.id === id)
    if (!bubble || bubble.phase === 'closing') return
    if (bubble.phase !== 'answering') return
    this.abort(id)
    void Promise.resolve().then(() => this.transport.stop?.(bubble.sessionId, id)).catch(() => {})
    this.failTurn(id, this.t('bubble.turn.cancelled'), true)
    this.update(id, { phase: 'partial' })
  }

  close(id: string): Promise<void> {
    const existing = this.closing.get(id)
    if (existing) return existing
    const item = this.snapshot.find(bubble => bubble.id === id)
    if (!item) return Promise.resolve()
    if (this.notStarted.has(id)) { this.remove(id); return Promise.resolve() }
    this.update(id, { phase: 'closing', error: undefined, closeFailed: false })
    this.abort(id)
    const operation = Promise.resolve().then(() => this.transport.close(item.sessionId, id)).then(result => {
      if (result.kind === 'error') throw new Error(result.text)
      this.remove(id)
    }).catch(error => {
      if (this.notStarted.has(id) || this.runEnd.get(id) === 'not-started') { this.remove(id); return }
      if (error instanceof SideRequestNotStartedError) {
        // 关闭被围栏拒绝只说明这次关闭没进 handler，不能说明启动没开始。
        this.closeFenced.add(id)
        const end = this.runEnd.get(id)
        if (end === 'aborted' || end === 'not-started') { this.remove(id); return }
      }
      this.update(id, { phase: 'error', closeFailed: true, error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { this.closing.delete(id); this.abort(id) })
    this.closing.set(id, operation)
    return operation
  }

  /** 刷新后恢复同一会话的气泡历史（只读文本 + 可继续追问）。 */
  hydrate(sessionId: string): void {
    if (this.disposed || this.hydrated.has(sessionId)) return
    this.hydrated.add(sessionId)
    this.sessions.add(sessionId)
    const loaded = this.read(sessionId)
    if (!loaded.length) return
    this.hydrating = true
    try {
      const existing = new Set(this.snapshot.map(item => item.id))
      const restored = loaded
        .filter(item => !existing.has(item.id))
        .map(item => {
          const turns = (item.turns ?? []).map(turn => turn.phase === 'answering'
            ? { ...turn, phase: 'error' as const, cancelled: true, error: this.t('bubble.turn.cancelled') }
            : turn)
          return { ...item, turns, restored: true, phase: turns.some(turn => turn.phase === 'answering') ? 'partial' as const : bubblePhase({ ...item, turns }) }
        })
      if (restored.length) this.publish([...this.snapshot, ...restored])
    } finally { this.hydrating = false }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all(this.snapshot.map(item => this.close(item.id)))
  }

  private isActive(id: string): boolean {
    if (this.active.has(id)) return true
    for (const key of this.active.keys()) if (key.startsWith(`${id}:`)) return true
    return false
  }

  private abort(id: string): void {
    for (const [key, controller] of this.active) {
      if (key === id || key.startsWith(`${id}:`)) {
        controller.abort()
        this.active.delete(key)
      }
    }
  }

  private completeTurn(id: string, answer: string): void {
    this.publish(this.snapshot.map(item => item.id === id
      ? { ...item, turns: mapLastTurn(item.turns, { answer, phase: 'done', error: undefined, cancelled: undefined }) }
      : item))
  }

  private failTurn(id: string, error: string, cancelled = false, partial?: string): void {
    this.publish(this.snapshot.map(item => item.id === id
      ? {
          ...item,
          turns: mapLastTurn(item.turns, {
            answer: partial ?? (cancelled ? lastTurn(item)?.answer ?? '' : ''),
            phase: 'error',
            error,
            ...(cancelled ? { cancelled: true } : {}),
          }),
        }
      : item))
  }

  private dropIfCloseCannotFinish(id: string): void {
    if (!this.closeFenced.has(id)) return
    const end = this.runEnd.get(id)
    if (end === 'not-started' || end === 'aborted') this.remove(id)
  }
  private remove(id: string): void {
    this.notStarted.delete(id)
    this.runEnd.delete(id)
    this.closeFenced.delete(id)
    this.abort(id)
    this.publish(this.snapshot.filter(item => item.id !== id))
  }
  private update(id: string, patch: Partial<Bubble>): void { this.publish(this.snapshot.map(item => item.id === id ? { ...item, ...patch } : item)) }
  private publish(snapshot: readonly Bubble[]): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
    this.persist()
  }

  private storageKey(sessionId: string): string { return `${STORAGE_PREFIX}${sessionId}` }

  private persist(): void {
    if (this.hydrating) return
    try {
      const storage = browserStorage()
      if (!storage) return
      const bySession = new Map<string, Bubble[]>()
      for (const item of this.snapshot) {
        if (item.phase === 'closing') continue
        const list = bySession.get(item.sessionId) ?? []
        list.push({
          ...item,
          restored: undefined,
          turns: item.turns?.map(turn => turn.phase === 'answering'
            ? { ...turn, phase: 'error' as const, cancelled: true, error: this.t('bubble.turn.cancelled') }
            : turn),
          phase: item.phase === 'answering' ? 'partial' : item.phase,
        })
        bySession.set(item.sessionId, list)
      }
      for (const sessionId of this.sessions) {
        const list = bySession.get(sessionId) ?? []
        if (list.length === 0) storage.removeItem(this.storageKey(sessionId))
        else storage.setItem(this.storageKey(sessionId), JSON.stringify({ version: STORAGE_VERSION, bubbles: list }))
      }
    } catch { /* localStorage 不可用时静默降级为纯内存 */ }
  }

  private read(sessionId: string): Bubble[] {
    try {
      const storage = browserStorage()
      if (!storage) return []
      const raw = storage.getItem(this.storageKey(sessionId))
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return []
      const value = parsed as { version?: unknown; bubbles?: unknown }
      if (value.version !== STORAGE_VERSION || !Array.isArray(value.bubbles)) return []
      const batch = value.bubbles.filter((item): item is Bubble => Boolean(item)
        && typeof item === 'object'
        && typeof (item as Bubble).id === 'string'
        && typeof (item as Bubble).question === 'string'
        && (item as Bubble).sessionId === sessionId)
      return batch.map(item => ({
        ...item,
        phase: item.phase === 'closing' ? 'done' : item.phase,
        turns: item.turns?.map(turn => ({ ...turn, phase: turn.phase === 'answering' ? 'error' as const : turn.phase })),
      }))
    } catch { return [] }
  }
}
