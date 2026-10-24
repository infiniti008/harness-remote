import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"

test("authenticated HTTP queues by default, edits in place, promotes once, and caches account limits", async (t) => {
  class Native extends EventEmitter {
    calls = []
    async start() {}
    async listSessions() { return [{ sessionId: "s", cwd: process.cwd(), title: "HTTP fixture" }] }
    notify() {}
    async request(method, params) {
      this.calls.push({ method, params })
      if (method === "session/load") return { sessionId: "s" }
      if (method === "session/prompt") await new Promise((resolve) => { this.release = resolve })
      if (method === "_session/steering") return { outcome: "injected" }
      if (method === "_account/rate_limits") return { rateLimits: { limitId: "codex", primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: 1800000000 } } }
      return { stopReason: "end_turn" }
    }
  }
  const native = new Native()
  const server = createBridgeServer({ config: { backend: "codex", username: "fixture", password: "fixture" }, acp: native, liveStatusProbe: null })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { native.release?.(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, method = "GET", body) => fetch(base + path, { method,
    headers: { Authorization: `Basic ${Buffer.from("fixture:fixture").toString("base64")}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.equal((await fetch(base + "/account/rate_limits")).status, 401)
  assert.equal(native.calls.length, 0)
  const limits = await (await request("/account/rate_limits")).json()
  assert.equal(limits.state, "available")
  assert.equal(limits.buckets[0].windows[0].usedPercent, 32)
  await request("/account/rate_limits")
  assert.equal(native.calls.filter((c) => c.method === "_account/rate_limits").length, 1)
  assert.equal((await request("/session/s/prompt_async", "POST", { parts: [{ type: "text", text: "original" }] })).status, 200)
  await request("/session/s/prompt_async", "POST", { parts: [{ type: "text", text: "queued" }] })
  const rows = await (await request("/session/s/message")).json()
  const queued = rows.find((row) => row.info.queued)
  assert.ok(queued)
  assert.equal(native.calls.some((c) => c.method === "_session/steering"), false)
  const route = `/session/s/queue/${encodeURIComponent(queued.info.id)}`
  assert.deepEqual(await (await request(route, "PATCH", { text: "edited" })).json(), { edited: true })
  const sent = await request(route, "POST", {})
  assert.equal(sent.status, 200)
  assert.equal((await sent.json()).messageID, queued.info.id)
  assert.equal((await request(route, "POST", {})).status, 409)
  assert.equal(native.calls.filter((c) => c.method === "_session/steering").length, 1)
  assert.equal(native.calls.find((c) => c.method === "_session/steering").params.prompt[0].text, "edited")
})
