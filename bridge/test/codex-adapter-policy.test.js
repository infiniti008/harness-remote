import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"
import { hardenCodexAdapter } from "../src/codex-adapter-policy.js"

const archive = process.env.HARNESS_CODEX_ACP_ARCHIVE || fileURLToPath(new URL("../../.vendor-cache/codex-acp-1.13.1.tgz", import.meta.url))
test("unreviewed adapter fails closed", () => assert.throws(() => hardenCodexAdapter("arbitrary adapter"), /Unsupported Codex ACP bundle/))

test("real codex-acp native chain cannot auto-review a failed sandbox or switch to full access", {
  skip: process.platform === "win32" || !existsSync(archive) ? "requires POSIX and pinned adapter archive (HARNESS_CODEX_ACP_ARCHIVE)" : false,
  timeout: 20000
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-native-policy-"))
  const logFile = path.join(temp, "native.jsonl")
  const escapedFile = path.join(temp, "escaped")
  let client
  try {
    assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), "93e2f215d9d68eb43afc98f46038eecf973996c0c522a8915249148b6ea35e01")
    execFileSync("tar", ["-xzf", archive, "-C", temp, "package/dist/index.js", "package/package.json"])
    const native = path.join(temp, "native.mjs")
    await copyFile(new URL("../scripts/fixtures/codex-native-policy-server.mjs", import.meta.url), native)
    await chmod(native, 0o755)
    client = new AcpClient({
      command: process.execPath,
      args: ["--v8-pool-size=1", "--max-old-space-size=96", fileURLToPath(new URL("../src/codex-adapter-entry.js", import.meta.url)), path.join(temp, "package/dist/index.js")],
      cwd: temp, authenticate: false,
      environment: { CODEX_PATH: native, CODEX_HOME: temp, HOME: temp, NATIVE_POLICY_LOG: logFile, NATIVE_POLICY_ESCAPE: escapedFile,
        INITIAL_AGENT_MODE: "agent-full-access", CODEX_CONFIG: JSON.stringify({ approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_mode: "danger-full-access", sandbox_workspace_write: { network_access: true, writable_roots: ["/"] } }) }
    })
    await client.start(5000)
    const created = await client.request("session/new", { cwd: temp, mcpServers: [] }, 5000)
    assert.deepEqual(created.modes.availableModes.map((mode) => mode.id), ["read-only"])
    assert.equal(created.modes.currentModeId, "read-only")
    await assert.rejects(client.request("session/set_mode", { sessionId: created.sessionId, modeId: "agent-full-access" }, 5000))
    await assert.rejects(client.request("session/set_config_option", { sessionId: created.sessionId, configId: "mode", value: "agent" }, 5000))
    await client.request("session/resume", { sessionId: "native-history-thread", cwd: temp, mcpServers: [] }, 5000)
    await client.request("session/load", { sessionId: "loaded-history-thread", cwd: temp, mcpServers: [] }, 5000)
    await client.request("session/fork", { sessionId: created.sessionId, cwd: temp, mcpServers: [] }, 5000)
    await client.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "Offline failed namespace fixture" }] }, 5000)
    const limits = await client.request("_account/rate_limits", {}, 5000)
    assert.equal(limits.rateLimits.primary.usedPercent, 17)
    const events = (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse)
    assert.deepEqual(events[0].argv, ["-c", 'approval_policy="never"', "-c", 'approvals_reviewer="user"', "-c", 'sandbox_mode="workspace-write"', "app-server"])
    const nativeRequests = events.filter((event) => ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(event.method))
    assert.deepEqual(nativeRequests.slice(0, 5).map((event) => event.method), ["thread/start", "thread/resume", "thread/resume", "thread/fork", "turn/start"])
    for (const event of nativeRequests) {
      assert.equal(event.params.approvalPolicy, "never")
      assert.equal(event.params.approvalsReviewer, "user")
      if (event.method === "turn/start") assert.deepEqual(event.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
      else {
        assert.equal(event.params.sandbox, "workspace-write")
        assert.equal(event.params.config.approval_policy, "never")
        assert.equal(event.params.config.sandbox_mode, "workspace-write")
        assert.equal(event.params.config.sandbox_workspace_write.network_access, false)
        assert.deepEqual(event.params.config.sandbox_workspace_write.writable_roots, [])
      }
    }
    const resume = nativeRequests.find((event) => event.params.threadId === "native-history-thread")
    assert.equal(resume.params.excludeTurns, true, "resume keeps native context without replaying display history")
    assert.equal(resume.params.history, undefined)
    const approvals = events.filter((event) => String(event.id).startsWith("approval-"))
    assert.deepEqual(approvals.slice(0, 3).map((event) => event.result), [{ decision: "decline" }, { decision: "decline" }, { permissions: {}, scope: "turn", strictAutoReview: false }])
    assert.equal(events.filter((event) => event.pid).length, 1, "limits reuse the native connection")
    assert.equal(events.filter((event) => event.method === "account/rateLimits/read").length, 1)
    assert.equal(existsSync(escapedFile), false)
    process.kill(events[0].pid, "SIGKILL")
    for (let attempt = 0; attempt < 100 && client.processID; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(client.processID, undefined, "native app-server death must end the adapter connection")
  } finally {
    await client?.close()
    await rm(temp, { recursive: true, force: true })
  }
})
