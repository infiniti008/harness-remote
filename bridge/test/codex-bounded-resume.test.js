import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { mkdtemp, open, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"

const id = "11111111-1111-4111-8111-000000000101"
const tick = () => new Promise((resolve) => setImmediate(resolve))

class NativeStub extends EventEmitter {
  sessionCapabilities = { resume: {} }
  calls = []
  promptCapabilities = {}
  async start() {}
  async listSessions() { return [{ sessionId: id, cwd: tmpdir(), updatedAt: new Date().toISOString() }] }
  notify() {}
  async request(method, params) {
    this.calls.push({ method, params })
    if (method === "session/load") throw new Error("Full replay is forbidden in this test")
    if (method === "session/prompt") {
      this.emit("notification", { method: "session/update", params: { sessionId: id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native answer" } } } })
      await new Promise((resolve) => { this.finishPrompt = resolve })
      return { stopReason: "end_turn" }
    }
    return {}
  }
}

test("40,000-message Codex resume uses a bounded seed, pages older history during a turn and never replays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-bounded-resume-"))
  const file = path.join(root, `rollout-${id}.jsonl`)
  const handle = await open(file, "w")
  for (let index = 0; index < 40_000; index++) {
    await handle.write(JSON.stringify({ timestamp: "2026-10-23T00:00:00Z", type: "event_msg",
      payload: { type: index % 2 ? "agent_message" : "user_message", message: `message ${index}` } }) + "\n")
  }
  await handle.close()
  const fingerprint = async () => createHash("sha256").update(await readFile(file)).digest("hex")
  const before = await fingerprint()
  const native = new NativeStub()
  const loader = createCodexHistoryLoader(root)
  let fullReads = 0
  const observed = Object.assign(async (...args) => { fullReads++; return loader(...args) }, loader)
  const service = new AcpService(native, { historyLoader: observed, journalPageWhileOwned: false })
  try {
    await assert.rejects(loader(id), { code: "HISTORY_READ_LIMIT" }, "the old full-read path still rejects this journal")
    await service.prompt(id, "continue without losing native context")
    assert.equal(service.status(id).type, "busy")
    assert.equal(fullReads, 0)
    assert.deepEqual(native.calls[0], { method: "session/resume", params: { sessionId: id, cwd: tmpdir(), mcpServers: [] } })
    let page = await service.messagePage(id, { limit: 500 })
    const cachedSeed = await loader.page(id, { limit: 200 })
    const seedText = cachedSeed.messages[0].parts[0].text
    page.messages[0].parts[0].text = "mutable live transcript"
    assert.equal(cachedSeed.messages[0].parts[0].text, seedText, "live transcript edits must not corrupt the revision page cache")
    assert.equal(page.messages.length, 202, "only 200 display records plus this turn are retained")
    assert.equal(page.messages.at(-1).parts[0].text, "native answer")
    const ids = new Set(page.messages.map((message) => message.info.id))
    while (page.before) {
      page = await service.messagePage(id, { limit: 500, before: page.before })
      for (const message of page.messages) {
        assert.equal(ids.has(message.info.id), false, "paging must not duplicate a seed/live message")
        ids.add(message.info.id)
      }
    }
    assert.equal(ids.size, 40_002)
    assert.equal(fullReads, 0)
    assert.equal((await service.messagePage(id, { limit: 500 })).messages.length, 202, "older pages never inflate the live cache")
    assert.equal(await fingerprint(), before, "UI windowing does not rewrite native context")
    native.finishPrompt()
    await tick()
    await service.prompt(id, "one more turn")
    native.finishPrompt()
    await tick()
    assert.equal(native.calls.filter((call) => call.method === "session/resume").length, 1)
    assert.equal(native.calls.some((call) => call.method === "session/load"), false)
  } finally {
    native.finishPrompt?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("an old adapter cannot silently fall back from bounded resume to full replay", async () => {
  const native = new NativeStub()
  native.sessionCapabilities = {}
  const loader = Object.assign(async () => { throw new Error("full read forbidden") }, {
    seed: async () => ({ messages: [], hasMore: false })
  })
  const service = new AcpService(native, { historyLoader: loader, journalPageWhileOwned: false })
  await assert.rejects(service.prompt(id, "continue"), /does not advertise bounded session\/resume/)
  assert.equal(native.calls.some((call) => call.method === "session/load"), false)
})
