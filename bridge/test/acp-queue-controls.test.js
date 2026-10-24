import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

class Native extends EventEmitter {
  calls = []
  notices = []
  promptCapabilities = { image: true }
  listeners = new Set()
  async start() {}
  async close() { this.release?.() }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  notify(method) { this.notices.push(method) }
  async listSessions() { return [{ sessionId: "s", cwd: "/tmp", title: "queue test" }] }
  async request(method, params) {
    this.calls.push({ method, params })
    if (method === "session/load") return { sessionId: "s" }
    if (method === "session/prompt" && !this.first) {
      this.first = true
      await new Promise((resolve) => { this.release = resolve })
    }
    if (method === "_session/steering") {
      if (this.steeringError) throw this.steeringError
      return { outcome: "injected" }
    }
    return { stopReason: "end_turn" }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i++) await tick()
  assert.ok(condition(), "expected queue lifecycle transition")
}

test("queue first, edit in place, explicit steering once and then drain remaining work", async (t) => {
  const native = new Native()
  const service = new AcpService(native, { midTurnPrompt: "steer" })
  t.after(() => native.release?.())
  await service.prompt("s", "original task")
  const attachment = { mime: "image/png", data: "aA==", filename: "test.png" }
  const queued = await service.prompt("s", "clarification", undefined, [attachment])
  assert.equal(queued.disposition, "queued")
  assert.equal(native.calls.filter((c) => c.method === "_session/steering").length, 0)
  const later = await service.prompt("s", "next task", undefined, [], undefined, "queue")
  assert.equal(await service.editQueued("s", queued.messageID, "updated clarification"), true)
  const outcomes = await Promise.allSettled([
    service.sendQueuedNow("s", queued.messageID), service.sendQueuedNow("s", queued.messageID)
  ])
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1)
  assert.equal(outcomes.find((r) => r.status === "rejected").reason.status, 409)
  const steering = native.calls.filter((c) => c.method === "_session/steering")
  assert.equal(steering.length, 1)
  assert.deepEqual(steering[0].params.prompt, [
    { type: "text", text: "updated clarification" }, { type: "image", mimeType: "image/png", data: "aA==" }
  ])
  assert.equal(native.notices.includes("session/cancel"), false)
  const rows = await service.messages("s")
  assert.equal(rows.filter((row) => row.info.id === queued.messageID).length, 1)
  assert.equal(rows.find((row) => row.info.id === queued.messageID).info.queued, undefined)
  assert.equal(rows.find((row) => row.info.id === later.messageID).info.queued, true)
  native.release()
  await until(() => service.status("s").type === "idle")
  assert.deepEqual(native.calls.filter((c) => c.method === "session/prompt").map((c) => c.params.prompt[0].text), ["original task", "next task"])
})

test("unsupported immediate delivery preserves queued entry", async (t) => {
  const native = new Native()
  const service = new AcpService(native)
  t.after(() => native.release?.())
  await service.prompt("s", "original")
  const queued = await service.prompt("s", "later", undefined, [], undefined, "queue")
  await assert.rejects(service.sendQueuedNow("s", queued.messageID), { status: 409 })
  assert.equal((await service.messages("s")).find((m) => m.info.id === queued.messageID).info.queued, true)
  native.release()
  await until(() => service.status("s").type === "idle")
})

test("lost steering acknowledgement never replays a possibly delivered message", async (t) => {
  const native = new Native()
  native.steeringError = new Error("transport timed out after delivery")
  const service = new AcpService(native, { midTurnPrompt: "steer" })
  t.after(() => native.release?.())
  await service.prompt("s", "original")
  const queued = await service.prompt("s", "once", undefined, [], undefined, "queue")
  await assert.rejects(service.sendQueuedNow("s", queued.messageID), { status: 503 })
  native.release()
  await until(() => service.status("s").type === "idle")
  assert.equal(native.calls.filter((c) => c.method === "session/prompt").length, 1)
  assert.equal(native.calls.filter((c) => c.method === "_session/steering").length, 1)
})

test("promotion racing with completion never executes a queued prompt twice", async (t) => {
  const native = new Native()
  const service = new AcpService(native, { midTurnPrompt: "steer" })
  t.after(() => native.release?.())
  await service.prompt("s", "original")
  const queued = await service.prompt("s", "once", undefined, [], undefined, "queue")
  native.release()
  await service.sendQueuedNow("s", queued.messageID).catch((error) => assert.equal(error.status, 409))
  await until(() => service.status("s").type === "idle")
  const sends = native.calls.filter((c) => ["session/prompt", "_session/steering"].includes(c.method) && c.params.prompt[0].text === "once")
  assert.equal(sends.length, 1)
})

test("promoting a later entry keeps its user row before its answer and remaining queue", async (t) => {
  const native = new Native()
  const service = new AcpService(native, { midTurnPrompt: "steer" })
  t.after(() => native.release?.())
  await service.prompt("s", "original")
  await service.prompt("s", "waiting")
  const promoted = await service.prompt("s", "promoted")
  await service.sendQueuedNow("s", promoted.messageID)
  native.emit("notification", { method: "session/update", params: { sessionId: "s", update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer to promoted" }
  } } })
  const rows = await service.messages("s")
  assert.deepEqual(rows.map((m) => `${m.info.role}:${m.parts[0]?.text}`), [
    "user:original", "user:promoted", "assistant:answer to promoted", "user:waiting"
  ])
})
