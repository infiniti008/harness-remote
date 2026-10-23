import assert from "node:assert/strict"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"
import { AcpService } from "../src/acp-service.js"
import { HistoryReadError, HistoryReadGate } from "../src/history-read-budget.js"

const id = "bounded-session"
const record = (text) => JSON.stringify({ timestamp: "2026-10-23T00:00:00Z", type: "event_msg", payload: { type: "user_message", message: text } }) + "\n"

test("a rejected large record is not cached and a later valid read recovers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-safety-"))
  const file = path.join(root, `rollout-${id}.jsonl`)
  try {
    await writeFile(file, record("x".repeat(6000)))
    const loader = createCodexHistoryLoader(root, { pageLimits: { maxLineBytes: 4096 } })
    await assert.rejects(loader.page(id), { code: "HISTORY_READ_LIMIT" })
    await writeFile(file, record("recovered"))
    assert.equal((await loader.page(id)).messages[0].parts[0].text, "recovered")
    assert.equal(loader.diagnostics().coldReads.active, 0)
    assert.equal(loader.diagnostics().pageCache.inFlight, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("full-history budget rejects while a small recent page remains accessible", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-safety-"))
  const file = path.join(root, `rollout-${id}.jsonl`)
  try {
    await writeFile(file, record("x".repeat(1000)).repeat(100))
    const loader = createCodexHistoryLoader(root, { fullLimits: { maxReadBytes: 4096 } })
    await assert.rejects(loader(id), { code: "HISTORY_READ_LIMIT" })
    const page = await loader.page(id, { limit: 2 })
    assert.equal(page.messages.length, 2)
    assert.equal(page.hasMore, true)
    await appendFile(file, record("new outside Harness"))
    assert.equal((await loader.page(id, { limit: 2 })).messages.at(-1).parts[0].text, "new outside Harness")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("page scan and retained-output budgets fail explicitly without truncating history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-safety-"))
  try {
    await writeFile(path.join(root, `rollout-${id}.jsonl`), record("x".repeat(1000)).repeat(10))
    await assert.rejects(createCodexHistoryLoader(root, { pageLimits: { maxReadBytes: 1024 } }).page(id), { code: "HISTORY_READ_LIMIT" })
    await assert.rejects(createCodexHistoryLoader(root, { pageLimits: { maxTextBytes: 1024 } }).page(id), { code: "HISTORY_READ_LIMIT" })
    await assert.rejects(createCodexHistoryLoader(root).page(id, { before: "garbage" }), { code: "INVALID_HISTORY_CURSOR" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("cold-read gate caps parallel work, bounds its queue and releases after failure", async () => {
  const gate = new HistoryReadGate({ maxActive: 1, maxQueued: 1 })
  let release
  const first = gate.run(() => new Promise((resolve) => { release = resolve }))
  const second = gate.run(() => { throw new Error("test failure") })
  const rejectedSecond = assert.rejects(second, /test failure/)
  await assert.rejects(gate.run(() => true), { code: "HISTORY_READ_BUSY" })
  assert.deepEqual(gate.diagnostics(), { active: 1, queued: 1, maxActive: 1, maxQueued: 1 })
  release()
  await first
  await rejectedSecond
  assert.equal(await gate.run(() => 42), 42)
  assert.equal(gate.active, 0)
})

test("read limits and located-journal page errors never trigger full-history or ACP fallback", async () => {
  for (const strict of [false, true]) {
    let fullReads = 0
    let acpLoads = 0
    const error = strict ? new Error("journal unreadable") : new HistoryReadError("budget exceeded")
    const loader = Object.assign(async () => { fullReads++; throw error }, {
      page: async () => { throw error }, strictPageErrors: strict
    })
    const acp = {
      on() {}, subscribe() { return () => {} },
      async listSessions() { return [{ sessionId: id, cwd: tmpdir(), updatedAt: new Date().toISOString() }] },
      async request() { acpLoads++; return {} }
    }
    const service = new AcpService(acp, { historyLoader: loader })
    try {
      await assert.rejects(service.messagePage(id), (reason) => reason === error)
      assert.equal(fullReads, 0)
      assert.equal(acpLoads, 0)
      if (!strict) {
        await assert.rejects(service.messages(id), (reason) => reason === error)
        assert.equal(fullReads, 1)
        assert.equal(acpLoads, 0)
      }
    } finally { /* This stub owns no timers, processes or file handles. */ }
  }
})
