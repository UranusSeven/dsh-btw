// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BubbleStore, type Bubble, type SideTransport } from '../src/client/bubbles'
import { BubbleView, transcriptOf } from '../src/client/BubbleView'
import { translate } from '../src/locales'
import { MAX_TURNS_PER_BUBBLE } from '../src/limits'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function transport(overrides: Partial<SideTransport> = {}): SideTransport & { run: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({ kind: 'success' as const, text: '首轮答案', multiturn: true }))
  const reply = vi.fn(async (_s: string, _i: string, turn: number) => ({ kind: 'success' as const, text: `第 ${turn} 轮答案`, multiturn: true }))
  const stop = vi.fn(async () => ({ kind: 'success' as const, text: '' }))
  const close = vi.fn(async () => ({ kind: 'success' as const, text: '' }))
  return { run, reply, stop, close, ...overrides } as never
}

let container: HTMLDivElement
let root: Root
const memory = new Map<string, string>()
const fakeStorage = {
  get length() { return memory.size },
  clear: () => { memory.clear() },
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  removeItem: (key: string) => { memory.delete(key) },
  key: (index: number) => [...memory.keys()][index] ?? null,
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  memory.clear()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeStorage })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('气泡多轮状态机', () => {
  it('追问追加到同一气泡，并按 turn 投递', async () => {
    const io = transport()
    const store = new BubbleStore(io, translate('zh'))
    expect(store.supportsReply).toBe(true)
    const id = await store.ask('s', 'Q1')
    await tick()
    expect(store.getSnapshot()[0]?.turns).toHaveLength(1)
    await expect(store.reply('s', id, 'Q2')).resolves.toBe(2)
    await tick()
    const bubble = store.getSnapshot()[0]!
    expect(bubble.turns).toHaveLength(2)
    expect(bubble.answer).toBe('第 2 轮答案')
    expect(bubble.question).toBe('Q1')
    expect(store.supportsReply).toBe(true)
    expect(io.reply).toHaveBeenCalledWith('s', id, 2, 'Q2', expect.any(AbortSignal), undefined)
  })

  it('失败轮次重试替换最后一轮，不额外占用轮数', async () => {
    const io = transport()
    io.reply.mockResolvedValueOnce({ kind: 'error' as const, text: '后端挂了', partial: '半截' })
    const store = new BubbleStore(io, translate('zh'))
    const id = await store.ask('s', 'Q1')
    await tick()
    await store.reply('s', id, 'Q2')
    await tick()
    expect(store.getSnapshot()[0]?.turns?.at(-1)).toMatchObject({ phase: 'error', answer: '半截' })
    expect(store.getSnapshot()[0]?.phase).toBe('error')
    await store.reply('s', id, 'Q2')
    await tick()
    expect(io.reply).toHaveBeenLastCalledWith('s', id, 2, 'Q2', expect.any(AbortSignal), undefined)
    expect(store.getSnapshot()[0]?.turns).toHaveLength(2)
  })

  it('停止当前轮保留气泡与历史，并调用 stop 命令', async () => {
    const pending = new Promise(() => {})
    const io = transport({ run: vi.fn(() => pending) as never })
    const store = new BubbleStore(io, translate('zh'))
    const id = await store.ask('s', 'Q1')
    store.stop(id)
    await tick()
    expect(io.stop).toHaveBeenCalledWith('s', id)
    const bubble = store.getSnapshot()[0]!
    expect(bubble.phase).toBe('partial')
    expect(bubble.turns?.[0]).toMatchObject({ cancelled: true, phase: 'error' })
    expect(bubble.turns).toHaveLength(1)
  })

  it('达到轮数上限后拒绝继续追问', async () => {
    const io = transport()
    const store = new BubbleStore(io, translate('zh'))
    const id = await store.ask('s', 'Q1')
    await tick()
    for (let turn = 2; turn <= MAX_TURNS_PER_BUBBLE; turn++) {
      await store.reply('s', id, `Q${turn}`)
      await tick()
    }
    expect(store.getSnapshot()[0]?.turns).toHaveLength(MAX_TURNS_PER_BUBBLE)
    await expect(store.reply('s', id, 'Q11')).rejects.toThrow('10 轮')
  })

  it('刷新后从 localStorage 恢复轮次，并继续追加', async () => {
    const io = transport()
    const first = new BubbleStore(io, translate('zh'))
    const id = await first.ask('s', 'Q1')
    await tick()
    await first.reply('s', id, 'Q2')
    await tick()
    expect(first.getSnapshot()[0]?.turns).toHaveLength(2)

    const restoredIo = transport()
    const second = new BubbleStore(restoredIo, translate('zh'))
    second.hydrate('s')
    const bubble = second.getSnapshot()[0]
    expect(bubble).toMatchObject({ id, restored: true, question: 'Q1' })
    expect(bubble?.turns).toHaveLength(2)
    await second.reply('s', id, 'Q3')
    expect(restoredIo.reply).toHaveBeenCalledWith('s', id, 3, 'Q3', expect.any(AbortSignal), undefined)
  })
})

describe('多轮气泡视图', () => {
  const reply = vi.fn(async () => {})
  const close = vi.fn()
  const stop = vi.fn()
  const item = (turns: Bubble['turns'], phase: Bubble['phase'] = 'done'): Bubble => ({
    id: 'bubble-view-1',
    sessionId: 's',
    question: turns?.[0]?.question ?? '',
    answer: turns?.at(-1)?.answer ?? '',
    phase,
    turns,
  })
  const render = async (bubble: Bubble) => {
    await act(async () => root.render(React.createElement(BubbleView, {
      item: bubble,
      close,
      stop,
      reply,
      t: translate('zh'),
      collapsed: false,
      onToggleCollapse: () => {},
    })))
  }
  const type = async (value: string, key = 'Enter', shift = false) => {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true }))
    })
  }

  it('按轮次渲染、显示轮数徽标并可复制全部轮次', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const bubble = item([
      { question: 'Q1', answer: 'A1', phase: 'done' },
      { question: 'Q2', answer: 'A2', phase: 'done' },
    ])
    await render(bubble)
    expect(container.querySelectorAll('.btw-turn')).toHaveLength(2)
    expect(container.textContent).toContain('2 轮')
    expect(container.querySelectorAll('.btw-turn-question')[1]?.textContent).toContain('Q2')
    expect(transcriptOf(bubble)).toContain('## Q2')
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制全部轮次"]')!
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('## A2'))
  })

  it('Enter 发送追问，Shift+Enter 与 IME Enter 不发送', async () => {
    await render(item([{ question: 'Q1', answer: 'A1', phase: 'done' }]))
    await type('追问内容', 'Enter', true)
    expect(reply).not.toHaveBeenCalled()
    await type('追问内容')
    expect(reply).toHaveBeenCalledWith('追问内容')
    reply.mockClear()
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })) })
    expect(reply).not.toHaveBeenCalled()
  })

  it('达到上限时禁用追问并提示新开气泡', async () => {
    const turns = Array.from({ length: MAX_TURNS_PER_BUBBLE }, (_, index) => ({ question: `Q${index + 1}`, answer: `A${index + 1}`, phase: 'done' as const }))
    await render(item(turns))
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toContain(`${MAX_TURNS_PER_BUBBLE} 轮上限`)
  })

  it('回答中提供独立停止按钮，不触发关闭', async () => {
    await render(item([{ question: 'Q1', answer: '', phase: 'answering' }], 'answering'))
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="停止回答"]')!
    await act(async () => button.click())
    expect(stop).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })
})
