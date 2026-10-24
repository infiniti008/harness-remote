const FIVE_HOURS_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60

function validWindow(window) {
  if (!window || typeof window !== "object") return undefined
  const usedPercent = window.usedPercent
  const windowDurationMins = window.windowDurationMins
  const resetsAt = window.resetsAt
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) return undefined
  return {
    usedPercent,
    windowDurationMins,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null
  }
}

function bucketLabel(bucket, key) {
  const id = typeof bucket?.limitId === "string" && bucket.limitId ? bucket.limitId : key
  const name = typeof bucket?.limitName === "string" && bucket.limitName ? bucket.limitName : undefined
  return { id, ...(name ? { name } : {}) }
}

/** Normalize only fields explicitly returned by Codex app-server. Missing data stays missing. */
export function normalizeCodexRateLimits(result, { updatedAt = Date.now() } = {}) {
  if (!result || typeof result !== "object") return unavailableCodexRateLimits()
  const root = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object"
    ? result.rateLimitsByLimitId
    : result.rateLimits && typeof result.rateLimits === "object"
      ? { [result.rateLimits.limitId ?? "codex"]: result.rateLimits }
      : null
  if (!root) return unavailableCodexRateLimits()

  const buckets = Object.entries(root).flatMap(([key, value]) => {
    if (!value || typeof value !== "object") return []
    const identity = bucketLabel(value, key)
    const windows = ["primary", "secondary"].flatMap((tier) => {
      const window = validWindow(value[tier])
      return window ? [{ tier, ...window }] : []
    })
    if (!windows.length) return []
    return [{ ...identity, windows }]
  })
  if (!buckets.length) return unavailableCodexRateLimits()
  return { state: "available", updatedAt, buckets }
}

export function unavailableCodexRateLimits(reason = "unavailable") {
  return { state: "unavailable", reason, updatedAt: null, buckets: [] }
}

export function codexQuotaWindows(rateLimits) {
  if (rateLimits?.state !== "available") return { fiveHour: null, weekly: null, other: [] }
  const all = rateLimits.buckets.flatMap((bucket) => bucket.windows.map((window) => ({ ...bucket, ...window })))
  const bucketID = rateLimits.buckets.find((bucket) => bucket.id === "codex")?.id ?? rateLimits.buckets[0]?.id
  const fiveHour = all.find((window) => window.id === bucketID && window.windowDurationMins === FIVE_HOURS_MINUTES) ?? null
  const weekly = all.find((window) => window.id === bucketID && window.windowDurationMins === WEEK_MINUTES) ?? null
  const other = all.filter((window) => window !== fiveHour && window !== weekly)
  return { fiveHour, weekly, other }
}
