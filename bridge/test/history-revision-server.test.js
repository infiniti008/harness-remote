import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"

test("authenticated revision probes avoid content reads and still observe external appends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "history-revision-"))
  const id = "test-revision-session"
  const file = path.join(root, `rollout-${id}.jsonl`)
  const record = (message) => JSON.stringify({ type: "event_msg", timestamp: "2026-10-23T00:00:00Z", payload: { type: "user_message", message } }) + "\n"
  class Fake extends EventEmitter {
    async listSessions() { return [{ sessionId: id, cwd: root, updatedAt: new Date().toISOString() }] }
    async request() { throw new Error("Viewing must not replay ACP history") }
    notify() {}
  }
  const loader = createCodexHistoryLoader(root, { pageLimits: { maxLineBytes: 4096 } })
  const server = createBridgeServer({ acp: new Fake(),
    config: { backend: "codex", host: "127.0.0.1", port: 0, username: "test", password: "fixture", roots: [root] },
    serviceOptions: { historyLoader: loader } })
  try {
    await writeFile(file, record("first"))
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${server.address().port}/session/${id}/message?limit=200`
    const headers = { Authorization: `Basic ${Buffer.from("test:fixture").toString("base64")}` }
    const first = await fetch(url, { headers })
    assert.equal(first.status, 200)
    assert.equal((await first.json())[0].parts[0].text, "first")
    const revision = first.headers.get("x-history-revision")
    assert.match(revision, /^[a-f0-9]{64}$/)
    const loads = loader.diagnostics().pageCache.loads
    const unchanged = await fetch(`${url}&if_revision=${revision}`, { headers })
    assert.equal(unchanged.status, 204)
    assert.equal(unchanged.headers.get("x-history-not-modified"), "1")
    assert.equal(await unchanged.text(), "")
    assert.equal(loader.diagnostics().pageCache.loads, loads)
    assert.equal((await fetch(`${url}&if_revision=${revision}`)).status, 401, "a cache hit never bypasses authentication")
    await appendFile(file, record("external update"))
    const changed = await fetch(`${url}&if_revision=${revision}`, { headers })
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.get("x-history-revision"), revision)
    assert.equal((await changed.json()).at(-1).parts[0].text, "external update")
    await writeFile(file, record("x".repeat(5000)))
    const oversized = await fetch(url, { headers })
    assert.equal(oversized.status, 413)
    assert.equal((await oversized.json()).code, "HISTORY_READ_LIMIT")
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
