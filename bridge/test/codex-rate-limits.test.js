import test from "node:test"
import assert from "node:assert/strict"
import { codexQuotaWindows, normalizeCodexRateLimits } from "../src/codex-rate-limits.js"
import { createCodexRateLimitsReader } from "../src/codex-rate-limits-server.js"

test("normalizes native multi-bucket windows and identifies only exact five-hour and weekly windows", () => {
  const rateLimits = normalizeCodexRateLimits({
    rateLimits: { limitId: "codex", primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex", limitName: "Codex",
        primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_800_500_000 }
      },
      codex_other: { limitId: "codex_other", primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1_800_000_500 } }
    }
  }, { updatedAt: 123 })
  const quota = codexQuotaWindows(rateLimits)
  assert.equal(rateLimits.state, "available")
  assert.equal(rateLimits.updatedAt, 123)
  assert.equal(quota.fiveHour.usedPercent, 29)
  assert.equal(quota.weekly.usedPercent, 61)
  assert.equal(quota.other.length, 1)
  assert.equal(quota.other[0].windowDurationMins, 60)
})

test("keeps absent, malformed and unsupported quota data unavailable", () => {
  assert.deepEqual(normalizeCodexRateLimits(null), { state: "unavailable", reason: "unavailable", updatedAt: null, buckets: [] })
  assert.equal(normalizeCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: "unknown", windowDurationMins: 300 } } } }).state, "unavailable")
  const nonstandard = normalizeCodexRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 720, resetsAt: null } } })
  const quota = codexQuotaWindows(nonstandard)
  assert.equal(quota.fiveHour, null)
  assert.equal(quota.weekly, null)
  assert.equal(quota.other[0].windowDurationMins, 720)
  assert.equal(quota.other[0].resetsAt, null)
})

test("caches successful reads for 60 seconds and coalesces concurrent reads", async () => {
  let now = 10_000
  let calls = 0
  let resolve
  const read = createCodexRateLimitsReader(() => {
    calls += 1
    return new Promise((done) => { resolve = done })
  }, { now: () => now })
  const first = read()
  const concurrent = read()
  await Promise.resolve()
  assert.equal(calls, 1)
  resolve({ rateLimits: { limitId: "codex", primary: { usedPercent: 50, windowDurationMins: 300 } } })
  const [a, b] = await Promise.all([first, concurrent])
  assert.deepEqual(a, b)
  assert.equal((await read()).buckets[0].windows[0].usedPercent, 50)
  assert.equal(calls, 1)
  now += 60_001
  const refreshed = read()
  await Promise.resolve()
  assert.equal(calls, 2)
  resolve({ rateLimits: { limitId: "codex", primary: { usedPercent: 80, windowDurationMins: 300 } } })
  assert.equal((await refreshed).buckets[0].windows[0].usedPercent, 80)
})

test("converts read failures and timeouts to unavailable", async () => {
  const failed = createCodexRateLimitsReader(() => { throw new Error("private transport detail") })
  assert.equal((await failed()).state, "unavailable")
  const timedOut = createCodexRateLimitsReader(() => new Promise(() => {}), { timeoutMs: 5 })
  assert.equal((await timedOut()).state, "unavailable")
})
