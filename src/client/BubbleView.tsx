import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUp, Check, ChevronDown, ChevronUp, Copy, LoaderCircle, MessageCircle, Square, X } from 'lucide-react'
import { AnswerMarkdown } from './answer-markdown'
import type { Bubble, BubbleStore, Turn } from './bubbles'
import { MAX_TURNS_PER_BUBBLE } from '../limits'
import type { BtwTranslate } from '../locales'

function legacyTurn(item: Bubble): Turn {
  return {
    question: item.question,
    ...(item.reference === undefined ? {} : { reference: item.reference }),
    answer: item.answer,
    phase: item.phase === 'answering' ? 'answering' : item.phase === 'error' ? 'error' : 'done',
    ...(item.error === undefined ? {} : { error: item.error }),
  }
}

function turnsOf(item: Bubble): Turn[] {
  return item.turns?.length ? [...item.turns] : [legacyTurn(item)]
}

/** 多轮气泡复制为一份可直接粘贴的 Markdown 记录；单轮保持只复制答案文本。 */
export function transcriptOf(item: Bubble): string {
  const turns = turnsOf(item)
  if (turns.length <= 1) return turns[0]?.answer ?? ''
  return turns
    .map((turn, index) => {
      const answer = turn.phase === 'error' && turn.cancelled ? `_${turn.error ?? ''}_` : turn.answer
      return `## Q${index + 1}\n\n${turn.question}\n\n## A${index + 1}\n\n${answer}`
    })
    .join('\n\n')
}

export function FollowUpComposer({ busy, limitReached, initialValue, onSend, onEscape, t }: {
  busy: boolean
  limitReached: boolean
  initialValue: string
  onSend: (text: string) => Promise<unknown>
  onEscape?: () => void
  t: BtwTranslate
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const disabled = busy || limitReached || sending
  const submit = async () => {
    const text = value.trim()
    if (!text || disabled) return
    setSending(true)
    setError(undefined)
    try {
      await onSend(text)
      setValue('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setSending(false) }
  }
  const placeholder = limitReached
    ? t('bubble.limit.turns', { max: MAX_TURNS_PER_BUBBLE })
    : busy ? t('status.answering') : t('bubble.followUp.placeholder')
  return <div className="btw-followup" data-btw-followup="">
    <textarea
      className="btw-followup-input"
      value={value}
      rows={1}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={t('bubble.followUp.placeholder')}
      onChange={event => setValue(event.target.value)}
      onKeyDown={event => {
        // IME 组字期间 Enter 必须送入候选，不能当成发送。
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault()
          void submit()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (value) setValue('')
          else onEscape?.()
        }
      }}
    />
    <button type="button" className="btw-followup-send" title={t('action.sendFollowUp')} aria-label={t('action.sendFollowUp')} disabled={disabled || !value.trim()} onClick={() => { void submit() }}>
      {sending ? <LoaderCircle size={14} className="btw-spinner" /> : <ArrowUp size={15} />}
    </button>
    <span className="btw-followup-hint">{t('bubble.followUp.hint')}</span>
    <span className="btw-followup-note">{t('bubble.contextFrozen')}</span>
    {error && <p className="btw-error" role="alert">{error}</p>}
  </div>
}

export function BubbleView({ item, close, stop, reply, restart, t, collapsed, onToggleCollapse, maxTurns = MAX_TURNS_PER_BUBBLE }: {
  item: Bubble
  close: () => void
  stop?: () => void
  reply?: (text: string) => Promise<unknown>
  restart?: (text: string) => Promise<unknown>
  t: BtwTranslate
  collapsed: boolean
  onToggleCollapse: () => void
  maxTurns?: number
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const tail = useRef<HTMLDivElement>(null)
  const turns = turnsOf(item)
  const latest = turns.at(-1)
  const busy = item.phase === 'answering' || item.phase === 'closing'
  const retrying = latest !== undefined && (latest.phase === 'error' || latest.cancelled === true)
  const limitReached = turns.length >= maxTurns && !retrying
  const copyAll = turns.length > 1
  const labels = useMemo(() => ({
    code: { copyLabel: t('action.copyCode'), copiedLabel: t('action.copiedCode') },
    footnotes: t('bubble.footnotes'),
  }), [t])
  // 新一轮或流式答案增长时把最新内容带到可视区；jsdom 没有 scrollIntoView 时静默跳过。
  useEffect(() => {
    const node = tail.current
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [turns.length, latest?.answer, latest?.phase, item.phase])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptOf(item))
      setCopied(true)
      setCopyError(false)
    } catch { setCopyError(true) }
  }
  const stopOrCloseTitle = item.closeFailed
    ? t('action.retryClose')
    : t('action.close')
  return <article className="btw-bubble" data-phase={item.phase} aria-label={t('bubble.label')}>
    <header className="btw-header">
      <span className="btw-symbol"><MessageCircle size={16} /></span>
      <span className="btw-question">{turns[0]?.question ?? item.question}</span>
      {turns.length > 1 && <span className="btw-turns">{t('bubble.turns', { count: turns.length })}</span>}
      <div className="btw-actions">
        {turns.some(turn => turn.answer) && <button type="button" title={t(copied ? 'action.copied' : copyAll ? 'action.copyAll' : 'action.copy')} aria-label={t(copyAll ? 'action.copyAll' : 'action.copy')} onClick={() => { void copy() }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>}
        <button type="button" title={t(collapsed ? 'action.expand' : 'action.collapse')} aria-label={t(collapsed ? 'action.expand' : 'action.collapse')} aria-expanded={!collapsed} onClick={onToggleCollapse}>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
        {item.phase === 'answering' && (
          <button type="button" className="btw-action-stop" title={t('action.stop')} aria-label={t('action.stop')} onClick={() => (stop ? stop() : close())}>
            <Square size={14} />
          </button>
        )}
        <button
          type="button"
          title={stopOrCloseTitle}
          aria-label={stopOrCloseTitle}
          disabled={item.phase === 'closing'}
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
    </header>
    {!collapsed && turns.map((turn, index) => {
      const showQuestion = turns.length > 1
      return <section className="btw-turn" data-phase={turn.phase} key={index}>
        {showQuestion && <div className="btw-turn-question"><span className="btw-turn-index">Q{index + 1}</span><span className="btw-turn-text">{turn.question}</span></div>}
        {turn.reference && <details className="btw-reference"><summary>{t('selection.reference')}</summary><blockquote>{turn.reference}</blockquote></details>}
        {turn.phase === 'answering' && <div className="btw-status" role="status"><LoaderCircle size={14} className="btw-spinner" />{t('status.answering')}</div>}
        {turn.answer && <div className="btw-answer"><AnswerMarkdown text={turn.answer} labels={labels} imageLabel={t('bubble.image')} /></div>}
        {turn.error && <p className="btw-error" role="alert">{turn.error}</p>}
      </section>
    })}
    <div ref={tail} />
    {item.restored && latest?.phase === 'error' && restart && (
      <button type="button" className="btw-restart" onClick={() => { void restart(latest.question).catch(() => {}) }}>{t('action.restartBubble')}</button>
    )}
    {item.phase === 'closing' && <div className="btw-status" role="status"><LoaderCircle size={14} className="btw-spinner" />{t('status.closing')}</div>}
    {item.closeFailed && item.error && <p className="btw-error" role="alert">{t('error.close', { detail: item.error })}</p>}
    {!item.turns?.length && item.error && !item.closeFailed && <p className="btw-error" role="alert">{item.error}</p>}
    {copyError && <p className="btw-error" role="alert">{t('error.copy')}</p>}
    {!collapsed && reply && item.phase !== 'closing' && <FollowUpComposer
      key={`${item.id}:${turns.length}:${latest?.phase ?? 'none'}:${latest?.cancelled === true ? 'cancelled' : 'live'}`}
      busy={item.phase === 'answering'}
      limitReached={limitReached}
      initialValue={retrying ? latest?.question ?? '' : ''}
      onSend={reply}
      onEscape={onToggleCollapse}
      t={t}
    />}
  </article>
}

export function BubbleDock({ store, sessionId, t }: { store: BubbleStore; sessionId: string; t: BtwTranslate }): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const items = snapshot.filter(item => item.sessionId === sessionId)
  const latestId = items.at(-1)?.id
  // 有气泡时才探测服务端能力，避免每个空会话都多一次命令往返。
  const hasItems = items.length > 0
  useEffect(() => { if (hasItems) void store.probe(sessionId) }, [store, sessionId, hasItems])

  // 手动覆盖状态：记录用户手动指定的展开 id（或 null 全部收起），同时记录设置该偏好时见到的气泡集合
  const [manual, setManual] = useState<{ id: string | null; knownIds: readonly string[] } | undefined>()

  // 仅当新气泡产生时（当前列表出现以往未见的新 id），才抢走展开焦点；单纯删除气泡不重置用户的手动偏好
  const hasNewlyAddedBubble = manual !== undefined && items.some(item => !manual.knownIds.includes(item.id))
  const currentIds = items.map(item => item.id)

  const isPinnedValid = manual !== undefined && !hasNewlyAddedBubble && manual.id !== null
    ? items.some(item => item.id === manual.id)
    : false

  const effectiveExpandedId = manual === undefined || hasNewlyAddedBubble
    ? latestId
    : (manual.id === null ? null : (isPinnedValid ? manual.id : latestId))

  if (!items.length) return null
  return <div className="btw-dock">
    {items.map(item => (
      <BubbleView
        key={item.id}
        item={item}
        t={t}
        collapsed={item.id !== effectiveExpandedId}
        onToggleCollapse={() => {
          if (item.id === effectiveExpandedId) setManual({ id: null, knownIds: currentIds })
          else setManual({ id: item.id, knownIds: currentIds })
        }}
        close={() => { void store.close(item.id) }}
        stop={() => store.stop(item.id)}
        reply={store.supportsReply ? text => store.reply(item.sessionId, item.id, text) : undefined}
        restart={text => store.ask(item.sessionId, text)}
      />
    ))}
  </div>
}
