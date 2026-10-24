import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import type { ServerConfig } from "../types"
import type { CodexRateLimitWindow, CodexRateLimits } from "../types"
import "../codex-rate-limits.css"

type Props = { rateLimits: CodexRateLimits | null }
type StatusProps = { config: ServerConfig, agentID: string, enabled?: boolean }
const POLL_INTERVAL_MS = 60_000

function resetText(resetsAt: number | null): string {
  if (!Number.isFinite(resetsAt)) return "reset time unavailable"
  return `resets ${new Date((resetsAt as number) * 1000).toLocaleString()}`
}

function preferredWindows(rateLimits: CodexRateLimits) {
  const windows = rateLimits.buckets.flatMap((bucket) => bucket.windows.map((window) => ({ bucket, window })))
  const bucketID = rateLimits.buckets.find((bucket) => bucket.id === "codex")?.id ?? rateLimits.buckets[0]?.id
  const preferred = (duration: number) => windows.find(({ bucket, window }) => bucket.id === bucketID && window.windowDurationMins === duration)
  return { windows, fiveHour: preferred(300), weekly: preferred(10_080) }
}

function percent(window: CodexRateLimitWindow | undefined): string {
  return window && Number.isFinite(window.usedPercent) ? `${Math.round(100 - window.usedPercent)}%` : "unavailable"
}

function Quota({ label, window }: { label: string, window?: CodexRateLimitWindow }) {
  if (!window || !Number.isFinite(window.usedPercent)) {
    return <div className="codex-quota-row"><span>{label}</span><span className="codex-quota-unknown">unavailable</span></div>
  }
  const remaining = Math.round(100 - window.usedPercent)
  return <div className="codex-quota-row">
    <span>{label}</span>
    <span><strong>{remaining}% remaining</strong><small>{resetText(window.resetsAt)}</small></span>
  </div>
}

export function CodexRateLimitsPanel({ rateLimits }: Props) {
  if (!rateLimits || rateLimits.state !== "available") {
    return <section className="codex-rate-limits" aria-label="Codex account limits">
      <span className="codex-rate-limits-title">Codex account limits</span>
      <span className="codex-quota-unknown">unavailable</span>
    </section>
  }
  const { windows, fiveHour, weekly } = preferredWindows(rateLimits)
  const shown = new Set([fiveHour, weekly].filter(Boolean))
  const other = windows.filter((entry) => !shown.has(entry))
  return <section className="codex-rate-limits" aria-label="Codex account limits">
    <span className="codex-rate-limits-title">Codex account limits</span>
    <Quota label="5-hour" window={fiveHour?.window} />
    <Quota label="Weekly" window={weekly?.window} />
    {other.map(({ bucket, window }) => <Quota
      key={`${bucket.id}:${window.tier}:${window.windowDurationMins}`}
      label={`${bucket.name ?? bucket.id} · ${window.windowDurationMins} min`}
      window={window}
    />)}
    <small className="codex-rate-limits-updated">
      {rateLimits.updatedAt === null ? "Update time unavailable" : `Updated ${new Date(rateLimits.updatedAt).toLocaleString()}`}
    </small>
  </section>
}

/** Poll the selected Codex machine only while this source conversation is visible. */
export function CodexRateLimitsStatus({ config, agentID, enabled = true }: StatusProps) {
  const [rateLimits, setRateLimits] = useState<CodexRateLimits | null>(null)
  const disclosure = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => { if (disclosure.current) disclosure.current.open = false }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close()
      disclosure.current?.querySelector("summary")?.focus()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape) }
  }, [open])
  useEffect(() => {
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const load = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return
      inFlight = true
      try {
        const value = await api.loadCodexRateLimits(config)
        if (!stopped) setRateLimits(value)
      } catch {
        if (!stopped) setRateLimits(null)
      } finally {
        inFlight = false
        if (!stopped && document.visibilityState === "visible") {
          timer = setTimeout(() => { void load() }, POLL_INTERVAL_MS)
        }
      }
    }
    const onVisibilityChange = () => {
      clearTimer()
      if (document.visibilityState === "visible") void load()
    }

    setRateLimits(null)
    if (!enabled || typeof document === "undefined") return () => { stopped = true }
    document.addEventListener("visibilitychange", onVisibilityChange)
    if (document.visibilityState === "visible") void load()
    return () => {
      stopped = true
      clearTimer()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [agentID, config.backend, config.host, config.port, config.username, config.password, config.agentId, enabled])

  if (!enabled) return null
  const summary = rateLimits?.state === "available"
    ? (() => {
        const { fiveHour, weekly } = preferredWindows(rateLimits)
        if (!fiveHour && !weekly) return "Limits unavailable"
        return `Limits · 5h ${percent(fiveHour?.window)} · week ${percent(weekly?.window)}`
      })()
    : "Limits unavailable"
  const compactSummary = rateLimits?.state === "available"
    ? (() => {
        const { fiveHour, weekly } = preferredWindows(rateLimits)
        if (!fiveHour && !weekly) return "Limits unavailable"
        return `5h ${percent(fiveHour?.window)} · wk ${percent(weekly?.window)}`
      })()
    : "Limits unavailable"
  return <details className="codex-rate-limits-disclosure" ref={disclosure} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary aria-label={`${summary}. Show Codex account limits`}>
      <span className="codex-rate-limits-summary-full">{summary}</span>
      <span className="codex-rate-limits-summary-compact">{compactSummary}</span>
    </summary>
    <div className="codex-rate-limits-popover"><CodexRateLimitsPanel rateLimits={rateLimits} /></div>
  </details>
}
