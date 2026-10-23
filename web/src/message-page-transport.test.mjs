import assert from "node:assert/strict"
import { api } from "./api.ts"
import { resolveNativeSessionTargetModel } from "./native-session-model.ts"

const config = { backend: "codex", agentId: "codex", host: "cache-test.invalid", port: 4902, username: "fixture", password: "fixture-only" }
const model = { providerID: "codex", modelID: "native-model", variant: "high" }
const messages = [{ info: { id: "first", sessionID: "transport-test", role: "user" }, parts: [] }]
const original = globalThis.fetch
const calls = []
let revision = "revision-one"
let body = messages
try {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url)
    await new Promise(resolve => setTimeout(resolve, 2))
    if (url.searchParams.get("if_revision") === revision) {
      return new Response(null, { status: 204, headers: { "x-history-not-modified": "1", "x-history-revision": revision } })
    }
    return new Response(JSON.stringify(body), { status: 200, headers: {
      "x-history-revision": revision, "x-session-model": encodeURIComponent(JSON.stringify(model)), "x-has-more": "0"
    } })
  }
  const target = { key: "fixture:codex:transport-test", backend: "codex", config, sessionID: "transport-test", directory: "/project", model: null }
  const [page, enriched] = await Promise.all([
    api.loadMessagePage(config, "transport-test", "/project", undefined, 200),
    resolveNativeSessionTargetModel(target)
  ])
  assert.equal(calls.length, 1, "model enrichment and initial window share the same real API request")
  assert.deepEqual(enriched.model, model)
  assert.deepEqual(page.messages, messages)
  const unchanged = await api.loadMessagePage(config, "transport-test", "/project", undefined, 200)
  assert.equal(calls.at(-1).searchParams.get("if_revision"), "revision-one")
  assert.equal(unchanged, page, "an unchanged page keeps its data/model identity")
  revision = "revision-two"
  body = [...messages, { info: { id: "outside-append", role: "assistant" }, parts: [] }]
  assert.equal((await api.loadMessagePage(config, "transport-test", "/project", undefined, 200)).messages.length, 2)
  for (const [otherConfig, directory] of [[{ ...config, host: "other.invalid" }, "/project"], [config, "/other-project"], [{ ...config, password: "changed" }, "/project"]]) {
    await api.loadMessagePage(otherConfig, "transport-test", directory, undefined, 200)
    assert.equal(calls.at(-1).searchParams.has("if_revision"), false, "different scopes never share a private page")
  }
  await api.loadMessagePage(config, "transport-test", "/project", undefined, 200, true)
  assert.equal(calls.at(-1).searchParams.has("if_revision"), false, "forced refresh is unconditional")
  assert.equal(calls.at(-1).searchParams.get("refresh"), "1")
  console.log("message-page transport: request sharing, revision validation, model metadata and scope isolation passed")
} finally { globalThis.fetch = original }
