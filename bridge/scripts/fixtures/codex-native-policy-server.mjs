#!/usr/bin/env node
// A deterministic native app-server transport, used below the real vendored ACP adapter.
// It never imports Codex, reads credentials or sends model/network requests.
import { appendFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = (event) => appendFileSync(process.env.NATIVE_POLICY_LOG, JSON.stringify(event) + "\n")
log({ argv: process.argv.slice(2), pid: process.pid })
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const thread = (id) => ({ id, cwd: process.cwd(), turns: [], historyMode: "legacy", status: { type: "idle" } })
const settings = (id) => ({ thread: thread(id), model: "fixture-model", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null })
let approvals = 0
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  log(message)
  if (!message.method) {
    // Deliberately unsolicited native approval requests must be refused without consulting ACP.
    if (String(message.id).startsWith("approval-")) {
      const accepted = message.result?.decision === "accept" || message.result?.decision === "acceptForSession"
      if (accepted) writeFileSync(process.env.NATIVE_POLICY_ESCAPE, "native escalation accepted")
      if (++approvals === 3) send({ method: "turn/completed", params: { threadId: "new-thread", turn: { id: "fixture-turn", status: "completed", items: [], error: null } } })
    }
    return
  }
  if (!Object.hasOwn(message, "id")) return
  const params = message.params ?? {}
  let result = {}
  switch (message.method) {
    case "initialize": result = { userAgent: "offline-fixture", codexHome: process.env.CODEX_HOME }; break
    case "account/read": result = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" }, requiresOpenaiAuth: true }; break
    case "config/read": result = { config: { model_provider: "openai" }, origins: {}, layers: [] }; break
    case "model/list": result = { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture model", description: "Offline", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "fixture" }], inputModalities: ["text"] }], nextCursor: null }; break
    case "thread/start": result = settings(params.ephemeral ? "title-thread" : "new-thread"); break
    case "thread/resume": result = settings(params.threadId); break
    case "thread/fork": result = settings("fork-thread"); break
    case "thread/read": result = { thread: thread(params.threadId) }; break
    case "skills/list": result = { data: [] }; break
    case "mcpServerStatus/list": result = { data: [], nextCursor: null }; break
    case "thread/backgroundTerminals/list": result = { data: [], nextCursor: null }; break
    case "thread/goal/get": result = { goal: null }; break
    case "account/rateLimits/read": result = { rateLimits: { limitId: "codex", primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null, credits: null, planType: "plus" } }; break
    case "turn/start": {
      if (params.threadId === "title-thread") {
        send({ id: message.id, result: { turn: { id: "title-turn", status: "inProgress", items: [], error: null } } })
        send({ method: "turn/completed", params: { threadId: "title-thread", turn: { id: "title-turn", status: "completed", items: [], error: null } } })
        return
      }
      // Simulate the reported failed-bwrap escalation: if native auto-review remains enabled,
      // write a marker without asking ACP. The repaired source must prevent this path entirely.
      if (params.approvalPolicy !== "never" || params.approvalsReviewer === "auto_review" || params.sandboxPolicy?.type !== "workspaceWrite") {
        writeFileSync(process.env.NATIVE_POLICY_ESCAPE, "failed sandbox automatically escalated")
      }
      result = { turn: { id: "fixture-turn", status: "inProgress", items: [], error: null } }
      send({ id: message.id, result })
      for (const [index, method] of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].entries()) {
        send({ id: `approval-${index}`, method, params: { threadId: params.threadId, turnId: "fixture-turn", itemId: "fixture-tool", reason: "offline denied namespace fixture", permissions: {} } })
      }
      return
    }
    default: break
  }
  send({ id: message.id, result })
})
