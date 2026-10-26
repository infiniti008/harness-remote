import assert from "node:assert/strict"
import test from "node:test"
import { createCodexNativeObservation } from "../src/codex-native-observation.js"
import { createBridgeServer } from "../src/server.js"

test("native observation preserves early completion, ignores late acknowledgements, and stores no payloads", () => {
  const native = createCodexNativeObservation()
  const start = { method: "turn/start", params: { threadId: "one", input: [{ text: "PRIVATE PROMPT" }] } }
  const first = native.requestStarted(start)
  native.notification({ method: "turn/completed", params: { threadId: "one", turn: { id: "old", status: "interrupted", items: ["PRIVATE"] } } })
  native.requestFinished(start, first, { turn: { id: "old", status: "inProgress" } }, false)
  assert.equal(native.read().sessions[0].turnStatus, "interrupted")
  const interrupt = { method: "turn/interrupt", params: { threadId: "one", turnId: "old" } }
  const pending = native.requestStarted(interrupt)
  const second = native.requestStarted(start)
  native.notification({ method: "turn/started", params: { threadId: "one", turn: { id: "new" } } })
  native.requestFinished(start, second, { turn: { id: "new", status: "inProgress" } }, false)
  native.notification({ method: "item/agentMessage/delta", params: { threadId: "one", turnId: "old", delta: "PRIVATE OLD" } })
  assert.equal(native.read().sessions[0].firstOutputAt, undefined)
  native.notification({ method: "item/reasoning/textDelta", params: { threadId: "one", turnId: "new", delta: "PRIVATE THOUGHT" } })
  native.requestFinished(interrupt, pending, {}, false)
  const observed = native.read()
  assert.equal(observed.sessions[0].turnID, "new")
  assert.equal(observed.sessions[0].turnStatus, "inProgress")
  assert.ok(observed.sessions[0].firstOutputAt)
  assert.equal(JSON.stringify(observed).includes("PRIVATE"), false)
  observed.sessions[0].events.length = 0
  assert.ok(native.read().sessions[0].events.length > 0, "returned snapshots cannot mutate retained events")
})

test("native observation has bounded thread and event retention", () => {
  const native = createCodexNativeObservation()
  for (let i = 0; i < 100; i++) {
    for (let n = 0; n < 30; n++) native.notification({ method: "item/agentMessage/delta", params: { threadId: `s${i}`, delta: "SECRET".repeat(10000) } })
  }
  const snapshot = native.read()
  assert.equal(snapshot.sessions.length, 64)
  assert.ok(snapshot.sessions.every((session) => session.events.length === 12))
  assert.ok(JSON.stringify(snapshot).length < 100000)
})

test("execution HTTP diagnostics require authentication and do not load or prompt a native Session", async () => {
  const calls = []
  const server = createBridgeServer({ config: { backend: "codex", username: "test", password: "private", roots: [] }, acp: {
    on() {}, request: async (method, params) => {
      calls.push({ method, params })
      return { profile: "core", observedAt: 123, disabledDiscoveryFeatures: ["plugins"], sessions: [{ threadID: "wanted", turnStatus: "inProgress" }, { threadID: "other" }] }
    }
  } })
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${server.address().port}/session/wanted/execution`
    assert.equal((await fetch(url)).status, 401)
    assert.equal(calls.length, 0)
    const response = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from("test:private").toString("base64")}` } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { profile: "core", observedAt: 123, disabledDiscoveryFeatures: ["plugins"], execution: { threadID: "wanted", turnStatus: "inProgress" } })
    assert.deepEqual(calls, [{ method: "_harness/native_status", params: {} }])
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
