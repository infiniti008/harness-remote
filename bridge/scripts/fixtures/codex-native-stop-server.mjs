#!/usr/bin/env node
// Deterministic app-server below the real pinned ACP adapter. No credentials or model calls.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const scenario = process.env.NATIVE_STOP_SCENARIO
const log = (event) => appendFileSync(process.env.NATIVE_STOP_LOG, JSON.stringify(event) + "\n")
const send = (message) => { log({ direction: "out", ...message }); process.stdout.write(JSON.stringify(message) + "\n") }
const thread = { id: "stop-thread", cwd: process.cwd(), turns: [], historyMode: "legacy", status: { type: "idle" } }
let turns = 0
let threads = 0
const completed = new Set()
const finish = (id, status) => {
  if (completed.has(id)) return
  completed.add(id)
  send({ method: "turn/completed", params: { threadId: thread.id, turn: { id, status, items: [], error: null } } })
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  log({ direction: "in", ...message })
  if (!message.method || !Object.hasOwn(message, "id")) return
  const respond = (result = {}) => send({ id: message.id, result })
  switch (message.method) {
    case "initialize": return respond({ userAgent: "offline-stop-fixture", codexHome: process.env.CODEX_HOME })
    case "account/read": return respond({ account: null, requiresOpenaiAuth: false })
    case "config/read": return respond({ config: { model_provider: "openai" }, origins: {}, layers: [] })
    case "model/list": return respond({ data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture", description: "Offline", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture" }], inputModalities: ["text"] }], nextCursor: null })
    case "thread/start": return respond({ thread: { ...thread, id: ++threads === 1 ? thread.id : `title-thread-${threads}` }, model: "fixture-model", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null })
    case "thread/read": return respond({ thread })
    case "skills/list": return respond({ data: [] })
    case "mcpServerStatus/list":
    case "thread/backgroundTerminals/list": return respond({ data: [], nextCursor: null })
    case "thread/goal/get": return respond({ goal: null })
    case "turn/start": {
      if (message.params.threadId !== thread.id) {
        respond({ turn: { id: "title-turn", status: "inProgress", items: [], error: null } })
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "title-turn", status: "completed", items: [], error: null } } })
        return
      }
      const id = `turn-${++turns}`
      const started = () => respond({ turn: { id, status: "inProgress", items: [], error: null } })
      if (turns === 1) {
        // The cancel notification reaches ACP while native turn/start still has no response.
        if (scenario === "late-start") setTimeout(started, 150)
        else started()
      } else {
        send({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: id, itemId: `answer-${id}`, delta: `NEXT_${id}` } })
        // Real transports can deliver completion before the corresponding turn/start reply.
        if (scenario === "early-next-completion") { finish(id, "completed"); started() }
        else { started(); setTimeout(() => finish(id, "completed"), 10) }
      }
      return
    }
    case "turn/interrupt": {
      const id = message.params.turnId
      if (scenario === "completion-before-ack") {
        finish(id, "interrupted")
        setTimeout(respond, 300)
      } else if (scenario === "interrupt-error") {
        send({ id: message.id, error: { code: -32600, message: "No active turn to interrupt" } })
        setTimeout(() => finish(id, "interrupted"), 50)
      } else {
        respond()
        setTimeout(() => finish(id, "interrupted"), 50)
      }
      return
    }
    default: return respond()
  }
})
