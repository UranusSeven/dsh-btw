import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { CAPABILITIES_COMMAND, CLOSE_COMMAND, MAX_QUESTION_LENGTH, parseReplyRequest, parseRequest, questionWithReference, REPLY_COMMAND, RUN_COMMAND, STOP_COMMAND } from './shared'
import { SIDE_MAX_OUTPUT_TOKENS } from './limits'
import { DEFAULT_TIMEOUT_MS, SideJobs } from './server/jobs'
import { ConversationRegistry } from './server/conversations'
import { createAnswerOnlyGuard, identityOfFromContext } from './server/tool-guard'
import { readSettings } from './server/settings'
import { translate } from './locales'
import { hideInternalCommands } from './server/command-visibility'

export const name = 'michengai-btw'
export const inject = ['commands', 'subagents', 'tools']
export { Config } from './server/settings'

interface GuardedAgent {
  ctx?: {
    tools: {
      guard(guard: ReturnType<typeof createAnswerOnlyGuard>): () => void | Promise<void>
    }
  }
}

/** 宿主命令只负责接入与身份绑定，不创建 HTTP 或持久侧聊接口。 */
export function apply(ctx: Context, config?: unknown): void {
  ctx.effect(() => hideInternalCommands(ctx.commands))
  const labels = new Set<string>()
  // 配置每读一次都重新解包：设置面板改完立即对下一次旁问生效，不需要重载插件。
  const settingsNow = () => readSettings(config)
  // 保护挂在子代理自己的上下文上，随子代理释放，不借用宿主根 fiber。
  // dsh-tui 会拒绝插件激活期间的 root.effect / root.events。
  const protection = createAnswerOnlyGuard(labels, identityOfFromContext(ctx), () => settingsNow().allowedTools)
  const releasePluginGuard = ctx.tools.guard(protection)
  const childGuards = new WeakMap<object, () => void | Promise<void>>()
  const arm = (agent: GuardedAgent) => {
    // child 级 guard 只是纵深防御：确定性拦截已由 ownId 预登记承担（agent.id === childId），
    // 因此 agent.ctx 尚未就绪时静默跳过不影响拦截能力；不要往这里加唯一的必要限制。
    protection.own(agent)
    if (!agent.ctx || childGuards.has(agent)) return
    childGuards.set(agent, agent.ctx.tools.guard(protection))
  }
  const releaseChild = async (agent: object | undefined) => {
    if (!agent) return
    const release = childGuards.get(agent)
    childGuards.delete(agent)
    await release?.()
  }
  const stopWatch = ctx.on('session/event', (session, event) => protection.recognize(session, event))
  const activeLabels = new Map<string, number>()
  const retainLabel = (l: string) => {
    activeLabels.set(l, (activeLabels.get(l) ?? 0) + 1)
    labels.add(l)
  }
  const releaseLabel = (l: string) => {
    const count = (activeLabels.get(l) ?? 1) - 1
    if (count <= 0) {
      activeLabels.delete(l)
      labels.delete(l)
    } else {
      activeLabels.set(l, count)
    }
  }

  /**
   * 0.2.1 的内部投递符号（process-stable）。优先用它而不是 remote face：
   * 这里已经有精确的父 Agent 对象，符号通道不需要再推导 principal，也不会
   * 被浏览器 remote 的 invocation 上下文拒绝。
   */
  const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')
  type PromptPart = { type: 'text'; text: string }
  const subagentFace = ctx.subagents as unknown as {
    prompt?: (request: {
      requestId: string
      parentSessionId: string
      childSessionId: string
      mode: 'continuable'
      delivery: 'queue'
      content: readonly PromptPart[]
    }, signal: AbortSignal) => Promise<unknown>
    interruptByParent?: (childSessionId: unknown, parentSessionId: unknown, mode: 'continuable') => unknown
    startActivation?: (spec: {
      provider: string
      label: string
      childId: ReturnType<typeof SessionId>
      request: { parent: Agent; prompt: readonly PromptPart[]; agentOptions?: { maxTokens?: number } }
      signal: AbortSignal
      delivery: 'caller'
    }) => Promise<{ result: Promise<{ stopReason: string; output: readonly { type: string; text?: string }[] }>; dispose(): Promise<void> }>
  }
  const deliverPrompt = (subagentFace as unknown as Record<symbol, unknown>)[DELIVER_PROMPT]
  const canContinue = typeof subagentFace.startActivation === 'function'
    && (typeof deliverPrompt === 'function' || typeof subagentFace.prompt === 'function')

  /** 旁问只做一次性只读回答，输出预算压到固定上限，并绝不反向抬高父路由预算。 */
  const maxTokensFor = (agent: Agent | undefined): number => {
    const parentMaxTokens = agent?.options?.maxTokens
    return typeof parentMaxTokens === 'number' && parentMaxTokens > 0
      ? Math.min(SIDE_MAX_OUTPUT_TOKENS, parentMaxTokens)
      : SIDE_MAX_OUTPUT_TOKENS
  }

  /** 首轮与追问共用同一段系统前缀；追问只追加用户消息，不重建子会话。 */
  const composeChildPrompt = (parentId: string, question: string, t: ReturnType<typeof translate>): string => {
    const settings = settingsNow()
    const replyHint = `\n\n${t('agent.replyHint', { parent: JSON.stringify(parentId) })}`
    const permissions = settings.allowedTools.length === 0 ? '' : `\n\n${t('agent.toolsAllowed', { tools: settings.allowedTools.join(', ') })}`
    const prefix = settings.promptPrefix === '' ? t('agent.promptPrefix') : settings.promptPrefix
    return `${prefix}${permissions}${replyHint}\n\n${question}`
  }

  let disposed = false
  const conversations = canContinue ? new ConversationRegistry({
    watch: listener => ctx.on('session/event', (session, event) => listener(session as never, event as never)),
    newChildId: () => globalThis.crypto.randomUUID(),
    start: async ({ parent, parentSessionId, childId, prompt, signal, locale }) => {
      const t = translate(locale)
      ensureInboxFilter(parent)
      const label = t('agent.name')
      retainLabel(label)
      const releaseChildId = protection.ownId(childId)
      let latestAgent: object | undefined
      // 冷恢复会创建新的 Agent 对象；监听器必须覆盖气泡整个生命周期，
      // 不能只包住首轮启动，否则第二轮就失去了 child 级纵深防御。
      const stopCreated = ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== childId) return undefined
        latestAgent = agent
        arm(agent as GuardedAgent)
        return undefined
      })
      let released = false
      const release = async () => {
        if (released) return
        released = true
        stopCreated()
        try { await releaseChild(latestAgent) }
        finally { releaseChildId(); releaseLabel(label) }
      }
      try {
        const activation = await subagentFace.startActivation!({
          provider: 'fork',
          label,
          childId: SessionId(childId),
          request: {
            parent: parent as Agent,
            agentOptions: { maxTokens: maxTokensFor(parent as Agent) },
            prompt: [{ type: 'text', text: composeChildPrompt(parentSessionId, prompt, t) }],
          },
          signal,
          delivery: 'caller',
        })
        // 多轮路径不 await activation.result（它在自然结算后才兑现）；仍要接住拒绝，
        // 否则一次 teardown 失败会变成未处理异常。
        void activation.result.catch(() => {})
        // 插件卸载与冷启动可能竞争：卸载后迟到的句柄必须在原地释放，不能成为孤儿。
        if (disposed) {
          try { await activation.dispose() }
          finally { await release() }
          throw new Error(t('error.stopped'))
        }
        return {
          // 空闲 TTL 只归还宿主激活名额，保留 guard 与 childId 供下一轮冷恢复。
          release: async () => { await activation.dispose() },
          dispose: async () => {
            try { await activation.dispose() }
            finally { await release() }
          },
        }
      } catch (error) {
        await release()
        throw error
      }
    },
    deliver: async ({ parent, parentSessionId, childId, text, signal }) => {
      ensureInboxFilter(parent)
      if (typeof deliverPrompt === 'function') {
        await (deliverPrompt as (parent: Agent, childId: unknown, content: PromptPart[], source: { kind: 'user' }, signal: AbortSignal, delivery: 'queue') => Promise<unknown>)
          .call(ctx.subagents, parent as Agent, SessionId(childId), [{ type: 'text', text }], { kind: 'user' }, signal, 'queue')
        return
      }
      if (typeof subagentFace.prompt === 'function') {
        await subagentFace.prompt({
          requestId: globalThis.crypto.randomUUID(),
          parentSessionId: SessionId(parentSessionId),
          childSessionId: SessionId(childId),
          mode: 'continuable',
          delivery: 'queue',
          content: [{ type: 'text', text }],
        }, signal)
        return
      }
      throw new Error(translate()('error.multiturnUnsupported'))
    },
    interrupt: (parentSessionId, childId) => {
      try { subagentFace.interruptByParent?.(SessionId(childId), SessionId(parentSessionId), 'continuable') }
      catch (error) { ctx.logger.warn(error) }
    },
    drain: async (parent, childId) => {
      const drain = (ctx.subagents as unknown as { drainChildren?: (agent: Agent, ids: readonly unknown[]) => Promise<void> }).drainChildren
      if (typeof drain === 'function') await drain.call(ctx.subagents, parent as Agent, [SessionId(childId)])
    },
  }, { onError: error => ctx.logger.warn(error), onIdle: () => { void maybeReleaseGuard() } }) : undefined

  /**
   * 冷恢复的子代理在宿主里按 `delivery: 'parent'` 重新物化，结算时宿主会给主
   * 会话注入一条 `subagent-settled` 通知（"Background subagent … finished"）。
   * 这条通知既会出现在主窗口，也会驱动主 Agent 再跑一轮，违反旁问「主对话零污染」。
   * 该事件按 agent scope 派发，因此挂在父 Agent 的 ctx 上（而不是根 ctx），
   * 在消息进入 inbox 的同步事件里移除；childId 归属由注册表精确判定。
   */
  const filteredParents = new WeakSet<object>()
  const stopInboxFilters: Array<() => void> = []
  const ensureInboxFilter = (parent: unknown): void => {
    if (!parent || typeof parent !== 'object' || filteredParents.has(parent)) return
    const parentCtx = (parent as { ctx?: { on?: (event: string, listener: (payload: unknown) => void) => () => void } }).ctx
    if (!parentCtx || typeof parentCtx.on !== 'function') return
    filteredParents.add(parent)
    const stop = parentCtx.on('agent/inbox/inserted', payload => {
      const { agent, message } = (payload ?? {}) as {
        agent?: { session?: { header?: { id?: string } }; inbox?: { remove(id: string): boolean } }
        message?: { id?: string; source?: { kind?: string; senderSessionId?: string } }
      }
      if (!agent || !message?.id) return
      const source = message.source
      if (source?.kind !== 'subagent-settled' || typeof source.senderSessionId !== 'string') return
      const parentId = conversations?.parentOfChild(source.senderSessionId)
      if (!parentId || agent.session?.header?.id !== parentId) return
      try { agent.inbox?.remove(message.id) }
      catch (error) { ctx.logger.warn(error) }
    })
    stopInboxFilters.push(stop)
  }

  const jobs = new SideJobs(async request => {
    // 0.2.1-rc.1 起只有 startActivation；0.2.0-rc.1 与 0.2.0-rc.2 仍只有 start。
    const provider = ctx.subagents.getProvider('fork')
    const t = translate(request.locale)
    if (!provider?.inheritsParentContext) {
      throw new Error(t('error.provider'))
    }
    const label = t('agent.name')
    retainLabel(label)
    const parentId = (request.context as Agent | undefined)?.session?.header?.id
    const settings = settingsNow()
    const replyHint = parentId === undefined ? '' : `\n\n${t('agent.replyHint', { parent: JSON.stringify(parentId) })}`
    // 自定义提示词替换内置前缀；工具权限句始终追加，配置不能让模型误以为「什么都能调」。
    const permissions = settings.allowedTools.length === 0 ? '' : `\n\n${t('agent.toolsAllowed', { tools: settings.allowedTools.join(', ') })}`
    const prefix = settings.promptPrefix === '' ? t('agent.promptPrefix') : settings.promptPrefix
    const promptText = `${prefix}${permissions}${replyHint}\n\n${request.question}`
    const subagents = ctx.subagents as unknown as {
      startActivation?: (spec: {
        provider: string
        label: string
        childId: ReturnType<typeof SessionId>
        request: { parent: Agent; prompt: readonly { type: string; text: string }[]; agentOptions?: { maxTokens?: number } }
        signal: AbortSignal
        delivery: 'caller'
      }) => Promise<{ result: Promise<{ stopReason: string; output: readonly { type: string; text?: string }[] }>; dispose(): Promise<void> }>
      start?: (provider: string, options: {
        parent: Agent
        label: string
        signal: AbortSignal
        agentOptions?: { maxTokens?: number }
        prompt: readonly { type: string; text: string }[]
      }) => Promise<{ result: Promise<{ stopReason: string; output: readonly { type: string; text?: string }[] }>; localAgent?: object; dispose(): Promise<void> }>
    }
    const parentAgent = request.context as Agent | undefined
    const parentMaxTokens = parentAgent?.options?.maxTokens
    const maxTokens = typeof parentMaxTokens === 'number' && parentMaxTokens > 0
      ? Math.min(SIDE_MAX_OUTPUT_TOKENS, parentMaxTokens)
      : SIDE_MAX_OUTPUT_TOKENS
    if (typeof subagents.startActivation === 'function') {
      const childId = SessionId(globalThis.crypto.randomUUID())
      const releaseChildId = protection.ownId(childId)
      let childAgent: object | undefined
      try {
        const stopCreated = ctx.on('agent/created', ({ agent }) => {
          if (agent.id !== childId) return undefined
          childAgent = agent
          // 只挂执行期拦截，不改系统提示、不过滤工具定义：请求前缀与主会话逐字节一致，
          // 才能复用主会话的 prompt cache（与 Claude Code /btw 一致）。
          arm(agent as GuardedAgent)
          return undefined
        })
        let activation
        try {
          activation = await subagents.startActivation({
            provider: 'fork',
            label,
            childId,
            request: {
              parent: request.context as Agent,
              // 旁问只需一次性只读回答：收紧继承来的过大输出预算，避免长会话溢出；
              // 同时取 min 避免反向抬高小预算路由。
              agentOptions: { maxTokens },
              prompt: [{ type: 'text', text: promptText }],
            },
            signal: request.signal,
            delivery: 'caller',
          })
        } finally {
          stopCreated()
        }
        // 结果落地即释放预登记 id：dispose 可能因 cleanup 超时未被调用，
        // 释放放在两处（此处与 dispose）保证 ownedIds 不会只增不减；重复释放无副作用。
        void activation.result.then(() => releaseChildId(), () => releaseChildId())
        return {
          result: activation.result,
          dispose: async () => {
            try { await activation.dispose() }
            finally {
              try { await releaseChild(childAgent) }
              finally { releaseChildId(); releaseLabel(label) }
            }
          },
        }
      } catch (error) {
        releaseChildId()
        releaseLabel(label)
        throw error
      }
    }
    if (typeof subagents.start !== 'function') {
      releaseLabel(label)
      throw new Error(t('error.provider'))
    }
    try {
      // 不传 persona / toolFilter，理由同上；工具由 AnswerOnlyGuard 在执行期拒绝。
      const run = await subagents.start('fork', {
        parent: request.context as Agent,
        label,
        signal: request.signal,
        agentOptions: { maxTokens },
        prompt: [{ type: 'text', text: promptText }],
      })
      if (run.localAgent) arm(run.localAgent)
      return {
        result: run.result,
        dispose: async () => {
          try { await run.dispose() }
          finally { await releaseChild(run.localAgent); releaseLabel(label) }
        },
      }
    } catch (error) { releaseLabel(label); throw error }
  }, DEFAULT_TIMEOUT_MS, {
    onError: error => ctx.logger.warn(error),
    // 迟到的启动句柄仍可能在卸载后到达；只有所有后台任务真正清空才注销根 guard，
    // 否则收尾中的子代理会短暂失去执行期拦截。
    onIdle: () => { void maybeReleaseGuard() },
  })
  let guardReleased = false
  const maybeReleaseGuard = async (): Promise<void> => {
    if (guardReleased || jobs.size > 0 || (conversations?.size ?? 0) > 0) return
    guardReleased = true
    stopWatch()
    await releasePluginGuard()
  }
  ctx.effect(() => () => (async () => {
    disposed = true
    for (const stop of stopInboxFilters.splice(0)) stop()
    await conversations?.dispose()
    await maybeReleaseGuard()
    await jobs.dispose()
    await maybeReleaseGuard()
  })())

  ctx.effect(() => ctx.commands.register({
    name: 'btw',
    description: translate()('command.description'),
    input: { hint: translate()('command.hint') },
    recordInput: false,
    handler: invocation => {
      const question = invocation.rawInput.trim()
      if (!question) return { kind: 'error', text: translate()('error.empty') }
      if (question.length > MAX_QUESTION_LENGTH) return { kind: 'error', text: translate()('error.length') }
      return jobs.ask(invocation.agent.session.header.id, globalThis.crypto.randomUUID(), question, invocation.signal, invocation.agent)
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: RUN_COMMAND,
    description: translate()('command.internalRun'),
    recordInput: false,
    handler: invocation => {
      try {
        const request = parseRequest(invocation.rawInput)
        const parentId = invocation.agent.session.header.id
        const question = questionWithReference(request.question, request.reference, request.locale)
        if (conversations) return conversations.start(parentId, request.id, question, invocation.signal, invocation.agent, request.locale)
        return jobs.ask(parentId, request.id, question, invocation.signal, invocation.agent, request.locale)
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : translate()('error.request') } }
    },
  }))
  // CommandResult 只承载 kind/text/sourceEventSeq，不能携带自定义能力字段；
  // 客户端通过这个隐藏命令显式探测多轮支持，旧服务端不认识它时自动降级。
  ctx.effect(() => ctx.commands.register({
    name: CAPABILITIES_COMMAND,
    description: translate()('command.internalCapabilities'),
    recordInput: false,
    handler: () => ({ kind: 'success' as const, text: conversations ? 'multiturn' : '' }),
  }))
  ctx.effect(() => ctx.commands.register({
    name: REPLY_COMMAND,
    description: translate()('command.internalReply'),
    recordInput: false,
    handler: invocation => {
      try {
        const request = parseReplyRequest(invocation.rawInput)
        const parentId = invocation.agent.session.header.id
        const text = questionWithReference(request.text, request.reference, request.locale)
        if (!conversations) return { kind: 'error' as const, text: translate(request.locale)('error.multiturnUnsupported') }
        return conversations.reply(parentId, request.id, request.turn, text, invocation.signal, invocation.agent, request.locale)
      } catch (error) { return { kind: 'error' as const, text: error instanceof Error ? error.message : translate()('error.request') } }
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: STOP_COMMAND,
    description: translate()('command.internalStop'),
    recordInput: false,
    handler: invocation => {
      const id = invocation.rawInput.trim()
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return { kind: 'error' as const, text: translate()('error.id') }
      if (!conversations) return { kind: 'error' as const, text: translate()('error.multiturnUnsupported') }
      return conversations.stop(invocation.agent.session.header.id, id)
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: CLOSE_COMMAND,
    description: translate()('command.internalClose'),
    recordInput: false,
    handler: invocation => {
      const id = invocation.rawInput.trim()
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return { kind: 'error', text: translate()('error.id') }
      const parentId = invocation.agent.session.header.id
      return conversations ? conversations.close(parentId, id, invocation.agent) : jobs.close(parentId, id)
    },
  }))
}
