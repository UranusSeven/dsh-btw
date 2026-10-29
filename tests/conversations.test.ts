import { describe, expect, it, vi } from 'vitest'
import { ConversationRegistry, type ConversationHost } from '../src/server/conversations'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function harness(options: { timeoutMs?: number; maxActive?: number; maxTurns?: number } = {}) {
  let listener: ((session: { header: { id: string } }, event: { type: string; data?: unknown }) => void) | undefined
  const delivered: Array<{ parentSessionId: string; childId: string; text: string }> = []
  const interrupted: Array<[string, string]> = []
  const disposed = vi.fn(async () => {})
  let child = ''
  const host: ConversationHost = {
    watch: fn => { listener = fn as never; return () => { listener = undefined } },
    newChildId: () => `child-${Math.random().toString(36).slice(2, 10)}`,
    start: async input => {
      child = input.childId
      return { dispose: disposed }
    },
    deliver: async input => { delivered.push({ parentSessionId: input.parentSessionId, childId: input.childId, text: input.text }) },
    interrupt: (parent, id) => { interrupted.push([parent, id]) },
  }
  const registry = new ConversationRegistry(host, { timeoutMs: 0, ...options })
  const emit = (event: { type: string; data?: unknown }) => listener?.({ header: { id: child } }, event)
  const answer = (turn: number, text: string) => {
    emit({ type: 'turn/start', data: { turn } })
    emit({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text }] }, stream: [] } })
    emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return { registry, emit, answer, delivered, interrupted, disposed, child: () => child }
}

describe('多轮旁问会话注册表', () => {
  it('首轮结束后不 dispose，追问投递到同一个 childId 并共享历史', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const first = h.registry.start('parent', 'bubble-0001', '问题一', signal, {})
    await tick()
    h.answer(4, '答案一')
    await expect(first).resolves.toMatchObject({ kind: 'success', text: '答案一' })
    expect(h.disposed).not.toHaveBeenCalled()
    expect(h.registry.size).toBe(1)

    const second = h.registry.reply('parent', 'bubble-0001', 2, '那第二点呢？', signal, {})
    await tick()
    expect(h.delivered).toEqual([{ parentSessionId: 'parent', childId: h.child(), text: '那第二点呢？' }])
    h.answer(5, '答案二')
    await expect(second).resolves.toMatchObject({ kind: 'success', text: '答案二' })
    expect(h.registry.size).toBe(1)
  })

  it('同一 turn 的重复投递回放缓存或复用进行中的 Promise，不重复发给宿主', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const first = h.registry.start('parent', 'bubble-0002', 'Q1', signal, {})
    await tick()
    h.answer(1, 'A1')
    await first

    const second = h.registry.reply('parent', 'bubble-0002', 2, 'Q2', signal, {})
    const duplicate = h.registry.reply('parent', 'bubble-0002', 2, 'Q2', signal, {})
    await tick()
    expect(h.delivered).toHaveLength(1)
    h.answer(2, 'A2')
    await expect(second).resolves.toMatchObject({ kind: 'success', text: 'A2' })
    await expect(duplicate).resolves.toMatchObject({ kind: 'success', text: 'A2' })
    await expect(h.registry.reply('parent', 'bubble-0002', 2, 'Q2', signal, {})).resolves.toMatchObject({ kind: 'success', text: 'A2' })
    expect(h.delivered).toHaveLength(1)
  })

  it('拒绝轮次越界与超前投递，并保留可读错误', async () => {
    const h = harness({ maxTurns: 2 })
    const signal = new AbortController().signal
    const first = h.registry.start('parent', 'bubble-0003', 'Q1', signal, {})
    await tick()
    h.answer(1, 'A1')
    await first
    expect((await h.registry.reply('parent', 'bubble-0003', 4, '跳轮', signal, {})).text).toContain('轮次')
    const second = h.registry.reply('parent', 'bubble-0003', 2, 'Q2', signal, {})
    await tick()
    h.answer(2, 'A2')
    await second
    expect((await h.registry.reply('parent', 'bubble-0003', 3, 'Q3', signal, {})).text).toContain('2 轮')
  })

  it('停止只中断当前轮，气泡保留并可重试同一 turn', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const first = h.registry.start('parent', 'bubble-0004', 'Q1', signal, {})
    await tick()
    h.answer(1, 'A1')
    await first

    const second = h.registry.reply('parent', 'bubble-0004', 2, 'Q2', signal, {})
    await tick()
    h.emit({ type: 'turn/start', data: { turn: 2 } })
    h.emit({ type: 'assistant/attempt', data: { turn: 2, step: 1, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['半截'] }] } })
    expect(h.registry.stop('parent', 'bubble-0004')).toEqual({ kind: 'success', text: '' })
    await expect(second).resolves.toMatchObject({ kind: 'error', text: '本轮已取消', partial: '半截' })
    expect(h.interrupted).toEqual([['parent', h.child()]])
    expect(h.registry.size).toBe(1)

    const retry = h.registry.reply('parent', 'bubble-0004', 2, 'Q2', signal, {})
    await tick()
    h.answer(3, 'A2')
    await expect(retry).resolves.toMatchObject({ kind: 'success', text: 'A2' })
  })

  it('关闭会中断、释放激活并拒绝迟到投递', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const first = h.registry.start('parent', 'bubble-0005', 'Q1', signal, {})
    await tick()
    h.answer(1, 'A1')
    await first
    await expect(h.registry.close('parent', 'bubble-0005')).resolves.toEqual({ kind: 'success', text: '' })
    expect(h.disposed).toHaveBeenCalledTimes(1)
    expect(h.registry.size).toBe(0)
    expect((await h.registry.reply('parent', 'bubble-0005', 2, '迟到', signal, {})).text).toContain('会话已结束')
    expect((await h.registry.start('parent', 'bubble-0005', '重建', signal, {})).text).toContain('已提交或已关闭')
  })

  it('关闭先于启动完成时，迟到激活被就地释放', async () => {
    let resolveStart!: (value: { dispose: () => Promise<void> }) => void
    const dispose = vi.fn(async () => {})
    let listener: ((session: { header: { id: string } }, event: unknown) => void) | undefined
    const registry = new ConversationRegistry({
      watch: fn => { listener = fn as never; return () => { listener = undefined } },
      newChildId: () => 'child-late',
      start: () => new Promise(resolve => { resolveStart = resolve }),
      deliver: async () => {},
      interrupt: () => {},
    }, { timeoutMs: 0 })
    const starting = registry.start('parent', 'bubble-0006', 'Q1', new AbortController().signal, {})
    await tick()
    await expect(registry.close('parent', 'bubble-0006')).resolves.toEqual({ kind: 'success', text: '' })
    resolveStart({ dispose })
    await tick()
    await expect(starting).resolves.toMatchObject({ kind: 'error' })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(listener).toBeDefined()
  })

  it('让出满额名额前拒绝新轮次', async () => {
    const h = harness({ maxActive: 1 })
    const signal = new AbortController().signal
    const first = h.registry.start('parent', 'bubble-0007', 'Q1', signal, {})
    await tick()
    expect((await h.registry.start('parent', 'bubble-0008', 'Q2', signal, {})).text).toContain('较多')
    h.answer(1, 'A1')
    await first
  })
})
