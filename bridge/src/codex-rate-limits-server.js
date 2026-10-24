import { normalizeCodexRateLimits, unavailableCodexRateLimits } from "./codex-rate-limits.js"
import { writeJSON } from "./http-policy.js"

/** Cache and coalesce a native Codex rate-limit read for one selected account/machine service. */
export function createCodexRateLimitsReader(readRateLimits, {
  ttlMs = 60_000,
  timeoutMs = 5_000,
  now = Date.now
} = {}) {
  let cached
  let cachedAt = 0
  let pending

  return async function read() {
    const timestamp = now()
    if (cached && timestamp - cachedAt < ttlMs) return cached
    if (pending) return pending
    pending = (async () => {
      let timer
      try {
        const response = await Promise.race([
          Promise.resolve().then(readRateLimits),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Codex rate-limit read timed out")), timeoutMs) })
        ])
        const normalized = normalizeCodexRateLimits(response, { updatedAt: now() })
        cached = normalized
        cachedAt = now()
        return normalized
      } catch {
        // Never turn a transport/auth failure into an empty or guessed quota.
        cached = unavailableCodexRateLimits()
        cachedAt = now()
        return cached
      } finally {
        clearTimeout(timer)
        pending = undefined
      }
    })()
    return pending
  }
}

/** Write the authenticated endpoint response after the owning route has selected its Codex agent. */
export async function serveCodexRateLimits(response, readRateLimits) {
  let value
  try {
    value = await readRateLimits()
  } catch {
    value = unavailableCodexRateLimits()
  }
  writeJSON(response, 200, value?.state === "available" ? value : unavailableCodexRateLimits())
}
