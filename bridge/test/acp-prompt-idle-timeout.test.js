import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"
import { createBridgeServer } from "../src/server.js"

class FakeChild extends EventEmitter {
  killed = false
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  constructor(onRequest) {
    super()
    this.stdout.setEncoding = () => undefined
    this.stderr.setEncoding = () => undefined
    this.stdin = {
      writable: true,
      write: (line, callback) => {
        onRequest(this, JSON.parse(line))
        callback?.()
        return true
      }
    }
  }

  respond(message) {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`)
  }

  kill() {
    this.killed = true
    this.stdin.writable = false
    this.exitCode = 0
    this.emit("exit", 0)
    return true
  }
}

function handshake(child, request) {
  if (request.method === "initialize") {
    child.respond({
      jsonrpc: "2.0",
      id: request.id,
      result: { agentInfo: { name: "test-agent", version: "1" }, authMethods: [] }
    })
  }
}

test("session prompt timeout measures inactivity instead of total turn duration", async () => {
  let promptRequest
  const child = new FakeChild((current, request) => {
    handshake(current, request)
    if (request.method === "session/prompt") promptRequest = request
  })
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()

  const prompt = client.request("session/prompt", { sessionId: "session-1", prompt: [] }, 35)

  await new Promise((resolve) => setTimeout(resolve, 25))
  child.respond({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "still working" } }
    }
  })

  await new Promise((resolve) => setTimeout(resolve, 25))
  child.respond({ jsonrpc: "2.0", id: promptRequest.id, result: { stopReason: "end_turn" } })

  assert.deepEqual(await prompt, { stopReason: "end_turn" })
  client.close()
})

test("activity from another session does not keep a stalled prompt alive", async () => {
  const child = new FakeChild((current, request) => handshake(current, request))
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()

  const prompt = client.request("session/prompt", { sessionId: "session-1", prompt: [] }, 30)
  await new Promise((resolve) => setTimeout(resolve, 20))
  child.respond({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-2",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "unrelated" } }
    }
  })

  await assert.rejects(prompt, /ACP adapter request timed out: session\/prompt/)
  client.close()
})

test("a timed-out turn is cancelled and settles before a retry reaches the native adapter", async () => {
  let active
  let cancelled = false
  let prompts = 0
  const child = new FakeChild((current, request) => {
    handshake(current, request)
    if (request.method === "session/prompt") {
      assert.equal(active, undefined, "a retry must not race the native active prompt")
      prompts += 1
      if (prompts === 1) active = request
      else current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
    }
    if (request.method === "session/cancel") {
      assert.equal(request.params.sessionId, "stalled")
      assert.equal(request.id, undefined, "ACP cancellation is a notification")
      setTimeout(() => {
        cancelled = true
        const original = active
        active = undefined
        current.respond({ jsonrpc: "2.0", id: original.id, result: { stopReason: "cancelled" } })
      }, 20)
    }
  })
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()
  try {
    await assert.rejects(client.request("session/prompt", { sessionId: "stalled", prompt: [] }, 20), /timed out/)
    assert.equal(cancelled, true, "report failure after the native cancellation response")
    assert.deepEqual(await client.request("session/prompt", { sessionId: "stalled", prompt: [] }), { stopReason: "end_turn" })
    assert.equal(client.diagnostics().pendingRequestCount, 0)
    assert.equal(child.killed, false, "cancelling one Session must not kill the shared adapter")
  } finally { client.close() }
})

test("an unresponsive cancellation blocks only that Session until its late response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let original
  let requests = 0
  const child = new FakeChild((current, request) => {
    handshake(current, request)
    if (request.method !== "session/prompt") return
    requests += 1
    if (requests === 1) original = request
    else current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  })
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()
  try {
    const failure = assert.rejects(client.request("session/prompt", { sessionId: "stalled" }, 20), /timed out/)
    t.mock.timers.tick(20)
    t.mock.timers.tick(5_000)
    await failure
    await assert.rejects(client.request("session/prompt", { sessionId: "stalled" }), /still stopping/)
    assert.equal(requests, 1, "a blocked retry must not reach the adapter")
    assert.deepEqual(await client.request("session/prompt", { sessionId: "other" }), { stopReason: "end_turn" })
    child.respond({ jsonrpc: "2.0", id: original.id, result: { stopReason: "cancelled" } })
    assert.deepEqual(await client.request("session/prompt", { sessionId: "stalled" }), { stopReason: "end_turn" })
    assert.equal(client.diagnostics().pendingRequestCount, 0)
  } finally { client.close() }
})

test("Stop retains the native writer until cancellation is acknowledged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let original
  let prompts = 0
  let cancels = 0
  const child = new FakeChild((current, request) => {
    handshake(current, request)
    if (request.method === "session/cancel") cancels += 1
    if (request.method !== "session/prompt") return
    prompts += 1
    if (prompts === 1) original = request
    else current.respond({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })
  })
  const client = new AcpClient({ spawnProcess: () => child })
  await client.start()
  try {
    const failure = assert.rejects(client.request("session/prompt", { sessionId: "stopping" }, 30_000), /did not confirm cancellation/)
    client.notify("session/cancel", { sessionId: "stopping" })
    assert.equal(client.diagnostics().pendingRequests[0].cancelling, true)
    await assert.rejects(client.request("session/prompt", { sessionId: "stopping" }), /still stopping/)
    t.mock.timers.tick(5_000)
    await failure
    await assert.rejects(client.request("session/prompt", { sessionId: "stopping" }), /still stopping/)
    assert.deepEqual(await client.request("session/prompt", { sessionId: "other" }), { stopReason: "end_turn" })
    child.respond({ jsonrpc: "2.0", id: original.id, result: { stopReason: "cancelled" } })
    assert.deepEqual(await client.request("session/prompt", { sessionId: "stopping" }), { stopReason: "end_turn" })
    assert.equal(cancels, 1)
    assert.equal(child.killed, false)
  } finally { await client.close() }
})

test("long silent turns stay busy beyond five minutes and settle on the native response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const prompts = []
  let cancels = 0
  const child = new FakeChild((current, request) => {
    handshake(current, request)
    if (request.method === "session/list") current.respond({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ sessionId: "long", cwd: "/tmp", title: "Long", updatedAt: new Date().toISOString() }] } })
    if (request.method === "session/load") current.respond({ jsonrpc: "2.0", id: request.id, result: {} })
    if (request.method === "session/prompt") prompts.push(request)
    if (request.method === "session/cancel") cancels += 1
  })
  const client = new AcpClient({ spawnProcess: () => child })
  // No listener is opened: exercise the real service/transport wiring without test sessions.
  const server = createBridgeServer({ config: { backend: "opencode2", promptIdleTimeoutMs: 1_800_000 }, acp: client })
  const service = server.acpService
  try {
    await client.start()
    await service.prompt("long", "summarize a large context")
    t.mock.timers.tick(10 * 60_000)
    assert.equal(service.status("long").type, "busy")
    assert.equal(cancels, 0)
    assert.equal(client.diagnostics().pendingRequests[0].timeoutMs, 1_800_000)
    // Activity resets the watchdog; the complete task can exceed its inactivity budget.
    for (let round = 0; round < 6; round += 1) {
      child.respond({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "long", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "working" } } } })
      t.mock.timers.tick(10 * 60_000)
    }
    assert.equal(cancels, 0)
    assert.equal(service.status("long").type, "busy")
    child.respond({ jsonrpc: "2.0", id: prompts[0].id, result: { stopReason: "end_turn" } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(service.status("long").type, "idle")
    assert.equal(client.diagnostics().pendingRequestCount, 0)
    await service.prompt("long", "a genuinely stalled request")
    t.mock.timers.tick(30 * 60_000)
    assert.equal(cancels, 1, "the finite silence budget requests a native cancellation")
    assert.equal(service.status("long").type, "busy", "wait for the native writer to acknowledge cancellation")
    assert.equal(client.diagnostics().pendingRequests[0].cancelling, true)
    child.respond({ jsonrpc: "2.0", id: prompts[1].id, result: { stopReason: "cancelled" } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(service.status("long").type, "idle")
    assert.equal(client.diagnostics().pendingRequestCount, 0)
    assert.ok((await service.messages("long")).some((message) => /no session activity/.test(message.info.error?.message ?? "")))
  } finally {
    server.emit("close")
    await client.close()
  }
})
