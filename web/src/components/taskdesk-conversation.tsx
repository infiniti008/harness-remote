import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ATTACHMENT_MAX_COUNT, fileToAttachment, imageFilesFromClipboard, type AttachmentPart } from "../attachments"
import type { QueuedPromptEntry } from "../mid-turn-policy"
import type { CommandInfo, MessageEnvelope } from "../types"
import { AlertIcon, ChatIcon, CloseIcon, JumpToBottomIcon, JumpToTopIcon, LoadingIcon, PaperclipIcon, StopCircleIcon } from "../Icons"
import "../taskdesk-conversation.css"
import "../taskdesk-history-loader.css"
import { TaskDeskMessageContent } from "./taskdesk-message-content"

const HARNESS_ICON_FILES: Record<string, string> = {
  codex: "codex.svg",
  claude: "claude.svg",
  opencode: "opencode.svg",
  opencode2: "opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

function harnessIconUrl(backend: string | undefined): string | undefined {
  if (!backend) return undefined
  const file = HARNESS_ICON_FILES[backend.toLowerCase()]
  return file ? `${import.meta.env.BASE_URL}harness-icons/${file}` : undefined
}

const NEAR_BOTTOM_PX = 96

/**
 * One remembered scroll position per transcript. Keyed by a caller-supplied `scrollScope` (the
 * Session it belongs to) so that switching away from a Session and back to a recently opened one
 * restores where the reader left off, instead of replaying "jump to the bottom" on every open even
 * when the history had to be re-read. The position is clamped on restore, so a reconnect that changed
 * the transcript cannot pin past the end of the new content. Bounded to an LRU so we do not retain
 * the position of every Session the app has ever opened.
 */
type ScrollSnapshot = {
  nearBottom: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  updatedAt: number
}

const SCROLL_MEMORY_LIMIT = 64
const SCROLL_MEMORY_STORAGE_KEY = "harness-remote.scroll-memory"
const SCROLL_MEMORY_PERSIST_DELAY_MS = 200
const scrollMemory = new Map<string, ScrollSnapshot>()

// The in-memory store is fast and handles live switches within one page, but a hard reload or a PWA
// teardown wipes it, so the remembered positions are mirrored to localStorage (the codebase's durable
// home for UI state). A reader who left a Session scrolled up then reloaded keeps that spot on the next
// open instead of falling back to the bottom, which is what "I reloaded but it still snaps" was about.
function scrollStorage(): Storage | null {
  try { return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage }
  catch { return null }
}

function serializeScrollMemory(): string {
  const entries: Record<string, ScrollSnapshot> = {}
  for (const key of scrollMemory.keys()) {
    const snapshot = scrollMemory.get(key)
    if (snapshot) entries[key] = snapshot
  }
  return JSON.stringify(entries)
}

function persistScrollMemoryNow(): void {
  const store = scrollStorage()
  if (!store) return
  try { store.setItem(SCROLL_MEMORY_STORAGE_KEY, serializeScrollMemory()) }
  catch { /* a private-mode or full store keeps the position for this page load only */ }
}

let scrollPersistTimer: ReturnType<typeof setTimeout> | undefined = undefined
function scheduleScrollPersist(): void {
  // Coalesce a burst of scroll-frame writes into a single durable write 200ms after the last one, so the
  // frame-throttled onScroll handler cannot stall the page under continuous scrolling.
  if (scrollPersistTimer !== undefined) return
  scrollPersistTimer = setTimeout(() => {
    scrollPersistTimer = undefined
    persistScrollMemoryNow()
  }, SCROLL_MEMORY_PERSIST_DELAY_MS)
}

let scrollUnloadWired = false
function wireScrollPersistOnExit(): void {
  // A hard reload or PWA exit tears down the in-memory store before its frame-throttled write can drain,
  // so flush it when the page hides or unloads: that guarantees the last remembered spot is durable for
  // the next open regardless of when, or whether, the scroll handler's timer got a turn to fire.
  if (scrollUnloadWired || typeof window === "undefined") return
  scrollUnloadWired = true
  const flush = () => persistScrollMemoryNow()
  window.addEventListener("pagehide", flush)
  window.addEventListener("visibilitychange", () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") persistScrollMemoryNow()
  })
}

let scrollMemoryHydrated = false
function readScrollMemory(scope: string | undefined): ScrollSnapshot | undefined {
  if (!scope) return undefined
  if (!scrollMemoryHydrated) {
    // Reloaded or freshly launched: the in-memory store is empty, so rehydrate it from the durable copy
    // the last session left behind. This is what makes reopen-after-reload restore the spot.
    scrollMemoryHydrated = true
    const store = scrollStorage()
    if (store) {
      try {
        const parsed = JSON.parse(store.getItem(SCROLL_MEMORY_STORAGE_KEY) || "{}") as Record<string, ScrollSnapshot>
        for (const key of Object.keys(parsed)) {
          const snapshot = parsed[key]
          // Only rehydrate well-formed entries so a corrupt or stale blob cannot poison a scope.
          if (snapshot && typeof snapshot.nearBottom === "boolean" && typeof snapshot.scrollTop === "number") {
            scrollMemory.delete(key)
            scrollMemory.set(key, snapshot)
          }
        }
      } catch { /* corrupt or private mode: start with an empty memory */ }
    }
  }
  return scrollMemory.get(scope)
}

function writeScrollMemory(scope: string | undefined, element: HTMLElement, nearBottom: boolean): void {
  if (!scope) return
  // Re-insert as newest so the most recently used Session is the last to be evicted.
  scrollMemory.delete(scope)
  scrollMemory.set(scope, {
    nearBottom,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    updatedAt: Date.now()
  })
  if (scrollMemory.size > SCROLL_MEMORY_LIMIT) {
    const oldest = scrollMemory.keys().next().value
    if (oldest !== undefined) scrollMemory.delete(oldest)
  }
  // Mirror to the durable store on a throttle; the unmount and page-exit flushes capture the very last
  // spot without waiting for the throttle to drain.
  scheduleScrollPersist()
}
const COMPOSER_MAX_HEIGHT_PX = 180
const JUMP_AFFORDANCE_MAX_THRESHOLD = 320
const JUMP_AFFORDANCE_MIN_RANGE = 240
/** Where the live tail sits while a turn runs, as a fraction of the transcript height from the top. */
const LIVE_TAIL_POSITION = 0.5

type Props = {
  messages: MessageEnvelope[]
  agentLabel: string
  agentBackend?: string
  loading?: boolean
  waiting?: boolean
  ready?: boolean
  hasMore?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => Promise<void> | void
  draft: string
  onDraftChange: (value: string) => void
  commands?: CommandInfo[]
  attachments?: AttachmentPart[]
  attachmentsSupported?: boolean
  onAttachmentsChange?: (attachments: AttachmentPart[]) => void
  onAttachmentError?: (message: string) => void
  onSend: () => Promise<void> | void
  sending?: boolean
  sendDisabled?: boolean
  /** Disable editing as well as Send while the owning Session is not safely writable yet. */
  composerDisabled?: boolean
  /**
   * Why the composer is waiting, shown as a status row above the field (for example while the model
   * catalog loads). A disabled field alone looks the same as an idle one, so the wait has to be named.
   */
  composerBusyLabel?: string
  onStop?: () => Promise<void> | void
  stopping?: boolean
  workingLabel?: string
  showWaitingIndicator?: boolean
  placeholder?: string
  emptyText?: string
  /** A failed transcript read is not a valid empty conversation and must remain visible as such. */
  transcriptError?: string
  directory?: string
  composerControls?: ReactNode
  composerStatus?: ReactNode
  footerHint?: string
  renderMessage?: (message: MessageEnvelope) => ReactNode
  /** Prompts accepted behind the running turn, rendered as the queued strip above the composer. */
  queuedPrompts?: QueuedPromptEntry[]
  /** Withdraw one queued prompt; renders the × on its row. */
  onCancelQueuedPrompt?: (id: string) => void
  /** Start one accepted queued prompt ahead of the remaining queue. */
  onSendQueuedPromptNow?: (id: string) => Promise<void> | void
  /** Update the text while preserving the queued prompt's attachments. `false` keeps the editor open. */
  onEditQueuedPrompt?: (id: string, text: string) => Promise<boolean | void> | boolean | void
  /**
   * The harness takes further prompts while its turn runs (steered into it or queued behind it), so
   * `sending`/`waiting` describe the running turn rather than gate the composer, and Send stays
   * available next to Stop.
   */
  canSendWhileWaiting?: boolean
  /**
   * The identity the transcript's scroll position is remembered for (the owning Session). Omitted
   * means "no memory": the transcript behaves exactly as before and never reads or writes a position.
   */
  scrollScope?: string
  /** Bumped when a cached Session surface becomes active again. */
  surfaceViewRevision?: number
}

type TranscriptProps = Pick<Props,
  "messages" | "agentLabel" | "agentBackend" | "loading" | "waiting" | "ready" | "hasMore" |
  "loadingOlder" | "onLoadOlder" | "sending" | "workingLabel" | "showWaitingIndicator" | "emptyText" |
  "transcriptError" | "renderMessage" | "scrollScope" | "surfaceViewRevision"
>

type JumpAffordances = { top: boolean; bottom: boolean }

function formatClock(timestamp: number): string {
  if (!timestamp) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp)
}

function hasTouchFirstPointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
}

/**
 * Size the room kept under a live turn so that, followed to the bottom, its newest line sits at
 * LIVE_TAIL_POSITION of the transcript instead of against the composer. What the agent writes next
 * then appears in open space, as in Claude and Codex.
 */
function sizeLiveRoom(transcript: HTMLElement, spacer: HTMLElement) {
  const paddingBottom = Number.parseFloat(window.getComputedStyle(transcript).paddingBottom) || 0
  const room = Math.max(0, Math.round(transcript.clientHeight * (1 - LIVE_TAIL_POSITION) - paddingBottom))
  spacer.style.height = `${room}px`
}

function jumpAffordancesFor(element: HTMLElement): JumpAffordances {
  const fromTop = Math.max(0, element.scrollTop)
  const fromBottom = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
  const range = fromTop + fromBottom
  if (range < JUMP_AFFORDANCE_MIN_RANGE) return { top: false, bottom: false }
  const threshold = Math.min(JUMP_AFFORDANCE_MAX_THRESHOLD, range * 0.25)
  return { top: fromTop > threshold, bottom: fromBottom > threshold }
}

const MessageBubble = memo(function MessageBubble({ message, agentLabel }: { message: MessageEnvelope; agentLabel: string }) {
  const isUser = message.info.role === "user"
  return (
    <article className={`uw-message ${isUser ? "uw-message-user" : "uw-message-agent"}`}>
      <div className={`uw-avatar ${isUser ? "uw-avatar-user" : "uw-avatar-agent"}`} aria-hidden="true">
        {isUser ? "You" : agentLabel.slice(0, 2).toUpperCase()}
      </div>
      <div className="uw-message-body">
        <header>
          <strong>{isUser ? "You" : agentLabel}</strong>
          <time>{formatClock(message.info.time.created)}</time>
        </header>
        <TaskDeskMessageContent message={message} />
      </div>
    </article>
  )
})

/**
 * The reply, before it has any content.
 *
 * The wait used to be staged in its own containers: a "getting started" card appeared, was removed,
 * and an agent message of a different shape took its place - and then said the same thing a second
 * time in a status row underneath its own name. Two avatars, two names, one turn.
 *
 * There is one identity row per reply and the wait happens *in* it. The row is the agent's avatar
 * and the line beside it; while the turn is live that line reads "<agent> is getting started" and
 * then "<agent> is working", and when the turn ends it reads the agent's name. Content, reasoning
 * and tool cards fill in underneath the row that is already there. Nothing is added, removed or
 * duplicated as the turn progresses - one line changes what it says.
 */
const ThinkingIndicator = memo(function ThinkingIndicator({ agentLabel, agentBackend, workingLabel }: { agentLabel: string; agentBackend?: string; workingLabel?: string }) {
  const icon = harnessIconUrl(agentBackend)
  return (
    <article className="uw-message uw-message-agent uw-message-pending">
      <div className="uw-avatar uw-avatar-agent" aria-hidden="true">
        {icon ? <img src={icon} alt="" /> : agentLabel.slice(0, 2).toUpperCase()}
      </div>
      <div className="uw-message-body">
        <header>
          <strong className="uw-message-working" role="status" aria-live="polite">
            {workingLabel || `${agentLabel} is working`}
            <span className="bui-typing" aria-hidden="true"><i /><i /><i /></span>
          </strong>
        </header>
      </div>
    </article>
  )
})

function transcriptPropsEqual(previous: TranscriptProps, next: TranscriptProps): boolean {
  return previous.messages === next.messages
    && previous.agentLabel === next.agentLabel
    && previous.agentBackend === next.agentBackend
    && previous.loading === next.loading
    && previous.waiting === next.waiting
    && previous.ready === next.ready
    && previous.hasMore === next.hasMore
    && previous.loadingOlder === next.loadingOlder
    && previous.sending === next.sending
    && previous.workingLabel === next.workingLabel
    && previous.showWaitingIndicator === next.showWaitingIndicator
    && previous.emptyText === next.emptyText
    && previous.transcriptError === next.transcriptError
    && previous.scrollScope === next.scrollScope
    && previous.surfaceViewRevision === next.surfaceViewRevision
}

/**
 * The transcript is deliberately memoized separately from the composer. Parent-owned draft state
 * changes on every keystroke, but a long conversation must not even walk its message array unless
 * transcript data or transcript state changed. Callback identities are intentionally ignored by the
 * comparator: a render that matters to the transcript also changes messages, agent identity or one
 * of the explicit transcript state props.
 */
const ConversationTranscript = memo(function ConversationTranscript({
  messages,
  agentLabel,
  agentBackend,
  loading = false,
  waiting = false,
  ready = true,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  sending = false,
  workingLabel,
  showWaitingIndicator = true,
  emptyText = "This conversation has no messages yet.",
  transcriptError,
  renderMessage,
  scrollScope,
  surfaceViewRevision
}: TranscriptProps) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Seed the "near bottom" intent from this scope's last remembered position, so reopening a Session
  // the reader had scrolled up in does not pin its tail back down. A first open has no entry yet.
  const restoreScrollRef = useRef<ScrollSnapshot | undefined>(scrollScope ? readScrollMemory(scrollScope) : undefined)
  const nearBottomRef = useRef(restoreScrollRef.current?.nearBottom ?? true)
  // Restore the exact saved position at most once per mount (guard against re-seeding on later renders).
  const restoredRef = useRef(false)
  const previousViewRevisionRef = useRef(surfaceViewRevision)
  const preservingOlderRef = useRef(false)
  const loadOlderRef = useRef(onLoadOlder)
  const followFrameRef = useRef<number | undefined>(undefined)
  const scrollFrameRef = useRef<number | undefined>(undefined)
  const previousSendingRef = useRef(false)
  const spacerRef = useRef<HTMLDivElement>(null)
  // Once a turn has run in this transcript it keeps its live room, including after the turn ends:
  // dropping the room at completion would yank the finished reply down against the composer.
  const liveRoomRef = useRef(false)
  const liveRef = useRef(false)
  const [jumpAffordances, setJumpAffordances] = useState<JumpAffordances>({ top: false, bottom: false })
  loadOlderRef.current = onLoadOlder

  function refreshJumpAffordances(element: HTMLElement) {
    const next = jumpAffordancesFor(element)
    setJumpAffordances((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }

  function openLiveRoom(current: HTMLElement) {
    liveRoomRef.current = true
    if (spacerRef.current) sizeLiveRoom(current, spacerRef.current)
  }

  // Wire the one-time page-exit flush (reload / PWA teardown) the first time a transcript mounts.
  useEffect(() => { wireScrollPersistOnExit() }, [])

  useEffect(() => () => {
    if (followFrameRef.current !== undefined) window.cancelAnimationFrame(followFrameRef.current)
    if (scrollFrameRef.current !== undefined) window.cancelAnimationFrame(scrollFrameRef.current)
    // Persist the read position so reopening this scope restores it instead of snapping to the bottom.
    // The passive cleanup can run after the surface is already detached, in which case its geometry reads
    // zero and would poison the store, so only flush a surface that is still live and sized.
    const element = transcriptRef.current
    if (element && element.isConnected && element.clientHeight > 0) {
      writeScrollMemory(scrollScope, element, nearBottomRef.current)
      // A chat switch may be followed by an immediate navigation, so capture the final spot now rather
      // than trusting the frame-throttled write to drain before the next render tears the surface down.
      persistScrollMemoryNow()
    }
  }, [])

  // Activate the cached tail before paint; retain remembered-position behavior for legacy consumers.
  // Restore the remembered position at most once per mount, on the first frame after the content has
  // rendered. The surface re-reads and shows "Loading conversation…" before the messages appear, so
  // this waits for that; it never fights an in-flight older-history load, and it keeps the reader's
  // "I was scrolled up" intent by not claiming the tail as the new bottom for them.
  useLayoutEffect(() => {
    const returningToView = surfaceViewRevision !== undefined
      && (!restoredRef.current || previousViewRevisionRef.current !== surfaceViewRevision)
    if (restoredRef.current && !returningToView) return
    const restore = restoreScrollRef.current
    const transcript = transcriptRef.current
    if ((!restore && !returningToView) || !transcript || preservingOlderRef.current || loading || !ready) return
    previousViewRevisionRef.current = surfaceViewRevision
    restoredRef.current = true
    if (returningToView) {
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: "instant" })
      nearBottomRef.current = true
      refreshJumpAffordances(transcript)
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const current = transcriptRef.current
      if (!current || preservingOlderRef.current) return
      const bottom = Math.max(0, current.scrollHeight - current.clientHeight)
      if (!restore) return
      // A reader who had scrolled up left an offset measured from the bottom of that (possibly longer)
      // window. Restore that offset, not the raw top distance: min(save, bottom) would collapse an
      // "up in history" reader straight to the tail whenever the freshly re-read window is shorter, which
      // looks like a jump to the bottom and then re-saves nearBottom as true, pinning every later open
      // there too. A shorter window instead pushes the reader up to the top, which still reads as "up".
      const offsetFromBottom = Math.max(0, restore.scrollHeight - restore.scrollTop - restore.clientHeight)
      const target = Math.max(0, bottom - offsetFromBottom)
      current.scrollTop = target
      nearBottomRef.current = target >= bottom - NEAR_BOTTOM_PX ? restore.nearBottom : false
      refreshJumpAffordances(current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [loading, ready, surfaceViewRevision])

  liveRef.current = sending || waiting

  // A reply keeps growing after the frame that followed it: message content renders after the
  // envelope arrives, and the transcript itself resizes with the window, the composer and a soft
  // keyboard. Re-settle on those too, or the newest lines end up under the composer. Outside a live
  // turn this only resizes the live room, so expanding an old tool card never moves the view.
  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return
    let frame: number | undefined
    const settle = () => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        if (preservingOlderRef.current) return
        if (liveRoomRef.current && spacerRef.current) sizeLiveRoom(transcript, spacerRef.current)
        if (nearBottomRef.current && liveRef.current) transcript.scrollTop = transcript.scrollHeight
        else if (!liveRoomRef.current) return
        refreshJumpAffordances(transcript)
      })
    }
    const resizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(settle)
    resizes?.observe(transcript)
    const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(settle)
    mutations?.observe(transcript, { childList: true, subtree: true, characterData: true })
    return () => {
      resizes?.disconnect()
      mutations?.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [])

  // A live turn - just sent, or already working when the Session opened - leaves its tail halfway up
  // the transcript, with room below for what comes next. Declared before the follow effect so the
  // room exists when that effect pins the tail. Opening the room adds space below the content and
  // moves nothing by itself.
  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript || loading || !ready || liveRoomRef.current || !(sending || waiting)) return
    openLiveRoom(transcript)
  }, [loading, ready, sending, waiting])

  useEffect(() => {
    const transcript = transcriptRef.current
    const startedSend = sending && !previousSendingRef.current
    previousSendingRef.current = sending
    if (!transcript || loading || !ready || preservingOlderRef.current) return

    // A deliberate send re-enters follow mode. After that, the user's scroll position wins. Status
    // changes such as Working -> Needs attention never move the transcript by themselves.
    if (startedSend) nearBottomRef.current = true
    if (!nearBottomRef.current || followFrameRef.current !== undefined) return

    const followTail = () => {
      const current = transcriptRef.current
      if (!current || preservingOlderRef.current || !nearBottomRef.current) return
      current.scrollTop = current.scrollHeight
      refreshJumpAffordances(current)
    }

    followFrameRef.current = window.requestAnimationFrame(() => {
      followTail()
      // Sending changes both the transcript (optimistic user turn) and the composer geometry. A
      // second frame is intentional only for that explicit Send: it waits for both layouts to settle
      // before pinning the new user bubble above the composer. Streaming updates keep the normal
      // single-frame follow behavior, and an upward user scroll still cancels follow via nearBottom.
      if (startedSend && nearBottomRef.current && !preservingOlderRef.current) {
        followFrameRef.current = window.requestAnimationFrame(() => {
          followFrameRef.current = undefined
          followTail()
        })
      } else {
        followFrameRef.current = undefined
      }
    })
  }, [messages, loading, ready, sending])

  // Content can become scrollable without a scroll event (initial load, tool expansion, streaming).
  // Refresh on transcript-state changes so the buttons never wait for the user to move first.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const current = transcriptRef.current
      if (current) refreshJumpAffordances(current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, loading, ready, sending, waiting])

  async function loadOlder() {
    const requestOlder = loadOlderRef.current
    if (!requestOlder || !hasMore || loadingOlder) return
    const transcript = transcriptRef.current
    const previousTop = transcript?.scrollTop ?? 0

    // History loading is an explicit move away from the live tail. Cancel any already-scheduled
    // follow frame before it can race the prepend and snap the transcript back to the newest turn.
    nearBottomRef.current = false
    preservingOlderRef.current = true
    if (followFrameRef.current !== undefined) {
      window.cancelAnimationFrame(followFrameRef.current)
      followFrameRef.current = undefined
    }

    try {
      await requestOlder()
      window.requestAnimationFrame(() => {
        const current = transcriptRef.current
        if (current) {
          // The history affordance is reached at the top of the transcript. Keep the same top-relative
          // position so the newly prepended messages are actually revealed. Compensating by their
          // added height could put a short initial page straight back at the bottom of the chat.
          current.scrollTop = Math.max(0, Math.min(previousTop, current.scrollHeight - current.clientHeight))
          nearBottomRef.current = false
          refreshJumpAffordances(current)
        }
        preservingOlderRef.current = false
      })
    } catch (error) {
      preservingOlderRef.current = false
      throw error
    }
  }

  function jumpToTop() {
    const current = transcriptRef.current
    if (!current) return
    nearBottomRef.current = false
    current.scrollTo({ top: 0, behavior: "smooth" })
  }

  function jumpToBottom() {
    const current = transcriptRef.current
    if (!current) return
    nearBottomRef.current = true
    current.scrollTo({ top: current.scrollHeight, behavior: "smooth" })
  }

  return (
    <div className="uw-transcript-shell">
      <div
        className="uw-transcript"
        role="log"
        aria-label="Conversation transcript"
        ref={transcriptRef}
        onWheel={(event) => {
          if (event.deltaY < 0) nearBottomRef.current = false
        }}
        onScroll={(event) => {
          const element = event.currentTarget
          if (scrollFrameRef.current !== undefined) return
          scrollFrameRef.current = window.requestAnimationFrame(() => {
            scrollFrameRef.current = undefined
            nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX
            refreshJumpAffordances(element)
            writeScrollMemory(scrollScope, element, nearBottomRef.current)
          })
        }}
      >
        {loading || !ready ? (
          <div className="uw-empty-panel"><LoadingIcon size={22} /><strong>Loading conversation…</strong></div>
        ) : (
          <>
            {hasMore ? (
              <div className="uw-history-loader">
                <button
                  type="button"
                  className="uw-history-load"
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                  title={loadingOlder ? "Loading earlier messages" : "Load earlier messages"}
                  aria-label={loadingOlder ? "Loading earlier messages" : "Load earlier messages"}
                >
                  {loadingOlder ? <LoadingIcon size={13} /> : <JumpToTopIcon size={13} />}
                  <span>{loadingOlder ? "Loading…" : "Earlier messages"}</span>
                </button>
              </div>
            ) : null}
            {transcriptError ? (
              <div className="uw-empty-panel uw-transcript-error" role="alert">
                <AlertIcon size={24} />
                <strong>Session history could not be loaded.</strong>
                <span>{transcriptError}</span>
              </div>
            ) : null}
            {messages.length === 0 && !waiting && !transcriptError ? (
              <div className="uw-empty-panel"><ChatIcon size={24} /><strong>{emptyText}</strong></div>
            ) : renderMessage
              ? messages.map((message) => renderMessage(message))
              : messages.map((message) => (
                  <MessageBubble key={message.info.id} message={message} agentLabel={agentLabel} />
                ))}
          </>
        )}
        {/* Loading history is a read, not a new reply. Wait for the transcript before deciding
            whether the live turn needs a placeholder or already has its own assistant bubble. */}
        {!loading && ready && (sending || (waiting && showWaitingIndicator)) ? <ThinkingIndicator agentLabel={agentLabel} agentBackend={agentBackend} workingLabel={workingLabel} /> : null}
        <div className="uw-transcript-reply-room" ref={spacerRef} aria-hidden="true" />
      </div>

      {jumpAffordances.top || jumpAffordances.bottom ? (
        <div className="uw-transcript-jumps" aria-label="Conversation navigation">
          {jumpAffordances.top ? (
            <button type="button" className="uw-transcript-jump" onClick={jumpToTop} title="Jump to top" aria-label="Jump to top">
              <JumpToTopIcon size={18} />
            </button>
          ) : null}
          {jumpAffordances.bottom ? (
            <button type="button" className="uw-transcript-jump" onClick={jumpToBottom} title="Jump to bottom" aria-label="Jump to bottom">
              <JumpToBottomIcon size={18} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}, transcriptPropsEqual)

/**
 * The conversation surface is deliberately product-agnostic. A Native Session and a Task provide
 * the same ordered native transcript and callbacks; this component owns how that transcript is
 * displayed, paged, scrolled and continued so those two products cannot slowly diverge.
 */
export function TaskDeskConversation({
  messages,
  agentLabel,
  agentBackend,
  loading = false,
  waiting = false,
  ready = true,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  draft,
  onDraftChange,
  commands = [],
  attachments = [],
  attachmentsSupported = false,
  onAttachmentsChange,
  onAttachmentError,
  onSend,
  sending = false,
  sendDisabled = false,
  composerDisabled = false,
  composerBusyLabel,
  onStop,
  stopping = false,
  workingLabel,
  showWaitingIndicator = true,
  placeholder,
  emptyText = "This conversation has no messages yet.",
  transcriptError,
  directory,
  footerHint,
  composerControls,
  composerStatus,
  queuedPrompts = [],
  onCancelQueuedPrompt,
  onSendQueuedPromptNow,
  onEditQueuedPrompt,
  canSendWhileWaiting = false,
  scrollScope,
  surfaceViewRevision,
  renderMessage
}: Props) {
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const composerFrameRef = useRef<number | undefined>(undefined)
  const [commandIndex, setCommandIndex] = useState(0)
  const [queuedPromptEditID, setQueuedPromptEditID] = useState<string | null>(null)
  const [queuedPromptDraft, setQueuedPromptDraft] = useState("")
  const [queuedPromptPendingID, setQueuedPromptPendingID] = useState<string | null>(null)
  const touchFirst = hasTouchFirstPointer()
  const commandToken = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : ""
  const commandMenuOpen = Boolean(draft.startsWith("/") && !draft.includes("\n") && !/\s/.test(commandToken) && commands.length)
  const commandMatches = useMemo(() => {
    if (!commandMenuOpen) return []
    const query = commandToken.toLowerCase()
    return commands
      .filter((command) => command.name.toLowerCase().includes(query) || (command.description || "").toLowerCase().includes(query))
      .slice(0, 8)
  }, [commands, commandMenuOpen, commandToken])
  // A consumer that never allows mid-turn prompts keeps the old gate: nothing is sent while a turn is
  // waiting or its reply is being prepared. One whose harness steers or queues opts in explicitly.
  const midTurnSend = canSendWhileWaiting && (waiting || sending)
  const canSend = Boolean(
    draft.trim()
    && (midTurnSend || (!sending && !waiting))
    && !sendDisabled
    && !composerDisabled
    && ready
  )
  // A phone has no Ctrl or Cmd key, so telling a touch user to press Ctrl/Cmd+Enter named the one
  // way to send that they do not have. Enter inserts a newline there; the Send button is the action.
  const composerBusy = Boolean(composerBusyLabel)
  const hint = footerHint ?? (touchFirst ? "Enter adds a line. Tap Send to send." : "Enter to send · Shift+Enter for a newline")

  async function runQueuedPromptAction(id: string, action: () => Promise<unknown> | unknown): Promise<unknown> {
    if (queuedPromptPendingID) return false
    setQueuedPromptPendingID(id)
    try {
      return await action()
    } catch {
      // The owning Session reports action failures in its normal error surface.
      return false
    } finally {
      setQueuedPromptPendingID(null)
    }
  }

  useEffect(() => {
    if (composerFrameRef.current !== undefined) window.cancelAnimationFrame(composerFrameRef.current)
    composerFrameRef.current = window.requestAnimationFrame(() => {
      composerFrameRef.current = undefined
      const composer = composerRef.current
      if (!composer) return
      composer.style.height = "auto"
      composer.style.height = `${Math.min(COMPOSER_MAX_HEIGHT_PX, Math.max(24, composer.scrollHeight))}px`
    })
    return () => {
      if (composerFrameRef.current !== undefined) {
        window.cancelAnimationFrame(composerFrameRef.current)
        composerFrameRef.current = undefined
      }
    }
  }, [draft])

  useEffect(() => {
    setCommandIndex(0)
  }, [commandToken])

  function chooseCommand(command: CommandInfo) {
    onDraftChange(`/${command.name} `)
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandMatches.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setCommandIndex((index) => (index + 1) % commandMatches.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setCommandIndex((index) => (index - 1 + commandMatches.length) % commandMatches.length)
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        chooseCommand(commandMatches[Math.min(commandIndex, commandMatches.length - 1)])
        return
      }
    }
    if (event.key !== "Enter") return
    if (touchFirst) {
      if (!event.ctrlKey && !event.metaKey) return
    } else if (event.shiftKey) {
      return
    }
    event.preventDefault()
    if (canSend) void onSend()
  }

  // A picker-selected image and a clipboard-pasted image share this one path: cap to the room still
  // free, run each through the same canvas normalisation, and hand the prepared parts back up.
  async function attachImageFiles(files: File[]) {
    const room = Math.max(0, ATTACHMENT_MAX_COUNT - attachments.length)
    const chosen = files.slice(0, room)
    if (!chosen.length) return
    try {
      const prepared = await Promise.all(chosen.map((file) => fileToAttachment(file)))
      onAttachmentsChange?.([...attachments, ...prepared])
    } catch (reason) {
      onAttachmentError?.(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="uw-conversation-core">
      <ConversationTranscript
        messages={messages}
        agentLabel={agentLabel}
        agentBackend={agentBackend}
        loading={loading}
        waiting={waiting}
        ready={ready}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
        sending={sending}
        workingLabel={workingLabel}
        showWaitingIndicator={showWaitingIndicator}
        emptyText={emptyText}
        transcriptError={transcriptError}
        renderMessage={renderMessage}
        scrollScope={scrollScope}
        surfaceViewRevision={surfaceViewRevision}
      />

      <div className="uw-composer-meta">
        <div className="uw-composer-context">
          {directory ? <span className="uw-composer-directory" title={directory}>{directory}</span> : null}
          {composerBusy ? null : <small id="uw-composer-hint">{hint}</small>}
        </div>
        {composerStatus}
      </div>
      <div className={`uw-composer-shell${composerBusy ? " busy" : ""}`} aria-busy={composerBusy || undefined}>
        {queuedPrompts.length ? (
          <div className="uw-queued-prompts" aria-label="Prompts waiting behind the running turn">
            {queuedPrompts.map((entry) => (
              <div className="uw-queued-prompt" key={entry.id}>
                <span className="uw-queued-prompt-badge">Queued</span>
                {queuedPromptEditID === entry.id ? (
                  <textarea
                    rows={2}
                    className="uw-queued-prompt-edit"
                    aria-label="Edit queued prompt"
                    value={queuedPromptDraft}
                    disabled={queuedPromptPendingID === entry.id}
                    onChange={(event) => setQueuedPromptDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault()
                        if (!queuedPromptPendingID && onEditQueuedPrompt) {
                          void runQueuedPromptAction(entry.id, () => onEditQueuedPrompt(entry.id, queuedPromptDraft))
                            .then((result) => {
                              if (result !== false) setQueuedPromptEditID(null)
                            })
                        }
                      } else if (event.key === "Escape") {
                        setQueuedPromptEditID(null)
                      }
                    }}
                  />
                ) : entry.text ? <span className="uw-queued-prompt-text">{entry.text}</span> : null}
                {entry.attachmentCount ? (
                  <span className="uw-queued-prompt-count">
                    {entry.attachmentCount} image{entry.attachmentCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                {queuedPromptEditID === entry.id ? (
                  <div className="uw-queued-prompt-actions">
                    <button
                      type="button"
                      className="uw-queued-prompt-action"
                      disabled={queuedPromptPendingID !== null}
                      onClick={() => {
                        if (!onEditQueuedPrompt || queuedPromptPendingID) return
                        void runQueuedPromptAction(entry.id, () => onEditQueuedPrompt(entry.id, queuedPromptDraft))
                          .then((result) => {
                            if (result !== false) setQueuedPromptEditID(null)
                          })
                      }}
                    >Save</button>
                    <button
                      type="button"
                      className="uw-queued-prompt-action"
                      disabled={queuedPromptPendingID !== null}
                      onClick={() => setQueuedPromptEditID(null)}
                    >Cancel</button>
                  </div>
                ) : (
                  <div className="uw-queued-prompt-actions">
                    {onSendQueuedPromptNow ? (
                      <button
                        type="button"
                        className="uw-queued-prompt-action"
                        disabled={queuedPromptPendingID !== null}
                        onClick={() => void runQueuedPromptAction(entry.id, () => onSendQueuedPromptNow(entry.id))}
                      >Send now</button>
                    ) : null}
                    {onEditQueuedPrompt ? (
                      <button
                        type="button"
                        className="uw-queued-prompt-action"
                        disabled={queuedPromptPendingID !== null}
                        onClick={() => {
                          setQueuedPromptDraft(entry.text)
                          setQueuedPromptEditID(entry.id)
                        }}
                      >Edit</button>
                    ) : null}
                  </div>
                )}
                {onCancelQueuedPrompt ? (
                  <button
                    type="button"
                    className="uw-queued-prompt-cancel"
                    disabled={queuedPromptPendingID !== null}
                    onClick={() => onCancelQueuedPrompt(entry.id)}
                    aria-label={`Remove queued prompt: ${entry.text || "attachments"}`}
                    title="Remove from queue"
                  >
                    <CloseIcon size={13} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {attachments.length ? (
          <div className="uw-composer-attachments" aria-label="Attached images">
            {attachments.map((attachment, index) => (
              <span className="uw-composer-attachment" key={`${attachment.filename}:${index}`}>
                <strong>{attachment.filename}</strong>
                <button
                  type="button"
                  onClick={() => onAttachmentsChange?.(attachments.filter((_, position) => position !== index))}
                  aria-label={`Remove ${attachment.filename}`}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {/* A placeholder is not a label: it disappears as soon as the field has content, which left
            the product's primary input unnamed for a screen reader.

            `enterKeyHint` labels the soft keyboard's action key. Enter inserts a newline on a touch
            device here, so promising "send" would name a behaviour that key does not have. */}
        {commandMatches.length ? (
          <div className="uw-command-suggestions" role="listbox" aria-label="Slash commands">
            {commandMatches.map((command, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === commandIndex}
                className={index === commandIndex ? "active" : ""}
                key={command.name}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseCommand(command)}
              >
                <strong>/${command.name}</strong>
                {command.description ? <span>{command.description}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {composerBusy ? (
          <div className="uw-composer-busy" id="uw-composer-busy" role="status" aria-live="polite">
            <LoadingIcon size={14} />
            <span>{composerBusyLabel}</span>
          </div>
        ) : null}
        <div className="uw-composer-input-row">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onComposerKeyDown}
            onPaste={(event) => {
              // A pasted image is attached like a picker pick, never pasted as raw bytes into the body.
              if (!attachmentsSupported) return
              const pasted = imageFilesFromClipboard(event.clipboardData)
              if (!pasted.length) return
              event.preventDefault()
              void attachImageFiles(pasted)
            }}
            placeholder={waiting ? `${agentLabel} is working…` : placeholder || `Continue with ${agentLabel}…`}
            rows={1}
            enterKeyHint={touchFirst ? "enter" : "send"}
            disabled={!ready || composerDisabled}
            aria-disabled={!ready || composerDisabled || undefined}
            aria-label={`Message ${agentLabel}`}
            aria-describedby={composerBusy ? "uw-composer-busy" : "uw-composer-hint"}
          />
          <div className="uw-composer-footer">
            <div className="uw-composer-inline-controls">
              {composerControls}
              {attachmentsSupported ? (
                <>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(event) => {
                      attachImageFiles(Array.from(event.target.files ?? []))
                      event.target.value = ""
                    }}
                  />
                  <button
                    type="button"
                    className="uw-button uw-composer-attach"
                    disabled={!ready || composerDisabled || sending || waiting || attachments.length >= ATTACHMENT_MAX_COUNT}
                    onClick={() => attachmentInputRef.current?.click()}
                    aria-label="Attach image"
                    title="Attach image"
                  >
                    <PaperclipIcon size={15} />
                  </button>
                </>
              ) : null}
              {waiting && onStop && midTurnSend && draft.trim() ? (
                // Stop alone left no way to deliver the message typed while the agent works - and no
                // way at all on a phone, where Enter only adds a line.
                <button
                  type="button"
                  className="uw-button uw-button-primary"
                  disabled={!canSend}
                  onClick={() => void onSend()}
                  aria-label="Send"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg><span className="uw-button-label">Send</span>
                </button>
              ) : null}
              {waiting && onStop ? (
                <button
                  type="button"
                  className="uw-button uw-button-danger"
                  disabled={stopping}
                  onClick={() => void onStop()}
                  aria-label={stopping ? "Stopping" : "Stop"}
                >
                  {stopping ? <LoadingIcon size={15} /> : <StopCircleIcon size={15} />}
                  <span className="uw-button-label">{stopping ? "Stopping" : "Stop"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="uw-button uw-button-primary"
                  disabled={!canSend}
                  onClick={() => void onSend()}
                  aria-label={sending && !midTurnSend ? "Sending" : "Send"}
                >
                  {sending && !midTurnSend ? <LoadingIcon size={15} /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>}
                  <span className="uw-button-label">{sending && !midTurnSend ? "Sending" : "Send"}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
