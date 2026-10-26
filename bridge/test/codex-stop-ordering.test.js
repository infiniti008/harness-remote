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

const archive = process.env.HARNESS_CODEX_ACP_ARCHIVE || fileURLToPath(new URL("../../.vendor-cache/codex-acp-1.13.1.tgz", import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(10) }
  throw new Error("Native fixture did not reach the required state")
}

for (const scenario of ["completion-before-ack", "ack-before-completion", "late-start", "interrupt-error", "early-next-completion"]) {
  test(`real pinned ACP Stop/NEXT ordering: ${scenario}`, {
    skip: process.platform === "win32" || !existsSync(archive) ? "requires POSIX and pinned adapter archive" : false,
    timeout: 15000
  }, async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "harness-stop-order-"))
    const nativeLog = path.join(temp, "native.jsonl")
    let client
    try {
      assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), "93e2f215d9d68eb43afc98f46038eecf973996c0c522a8915249148b6ea35e01")
      execFileSync("tar", ["-xzf", archive, "-C", temp, "package/dist/index.js", "package/package.json"])
      const native = path.join(temp, "native.mjs")
      await copyFile(new URL("../scripts/fixtures/codex-native-stop-server.mjs", import.meta.url), native)
      await chmod(native, 0o755)
      const events = async () => (await readFile(nativeLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse)
      client = new AcpClient({
        command: process.execPath,
        args: ["--v8-pool-size=1", "--max-old-space-size=96", fileURLToPath(new URL("../src/codex-adapter-entry.js", import.meta.url)), path.join(temp, "package/dist/index.js")],
        cwd: temp, authenticate: false,
        environment: { CODEX_PATH: native, CODEX_HOME: temp, HOME: temp, NATIVE_STOP_SCENARIO: scenario, NATIVE_STOP_LOG: nativeLog }
      })
      const errors = []
      client.on("stderr", (line) => errors.push(line))
      await client.start(5000)
      const { sessionId } = await client.request("session/new", { cwd: temp, mcpServers: [] }, 5000)
      const first = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "HOLD" }] }, 5000)
      // Capture rejection immediately, including failures before awaiting Stop.
      first.catch(() => {})
      await until(async () => (await events()).some((event) => event.method === "turn/start"))
      await client.cancelSession(sessionId)
      assert.equal((await first).stopReason, "cancelled", errors.join("\n"))
      assert.equal(client.isSessionStopping(sessionId), false)
      const text = []
      client.on("notification", (event) => {
        const update = event.params?.update
        if (update?.sessionUpdate === "agent_message_chunk") text.push(update.content.text)
      })
      const next = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "NEXT" }] }, 5000)
      assert.equal(next.stopReason, "end_turn", errors.join("\n"))
      assert.equal(text.join(""), "NEXT_turn-2")
      // Allow the old interrupt acknowledgement to arrive after NEXT has completed.
      if (scenario === "completion-before-ack") await delay(350)
      assert.equal(client.diagnostics().pendingRequestCount, 0)
      const transport = await events()
      assert.equal(transport.filter((event) => event.method === "turn/start" && event.params.threadId === sessionId).length, 2)
      assert.ok(transport.filter((event) => event.method === "turn/interrupt").every((event) => event.params.turnId === "turn-1"), "old cancellation must never target NEXT")
      if (scenario === "completion-before-ack") {
        const interrupt = transport.find((event) => event.method === "turn/interrupt")
        const ackIndex = transport.findIndex((event) => event.direction === "out" && event.id === interrupt.id)
        const nextIndex = transport.findIndex((event) => event.method === "turn/start" && event.params.input.some((part) => part.text === "NEXT"))
        assert.ok(nextIndex >= 0 && ackIndex > nextIndex, "late-ack race must actually be exercised")
      }
    } finally {
      await client?.close()
      await rm(temp, { recursive: true, force: true })
    }
  })
}
