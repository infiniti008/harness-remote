#!/usr/bin/env node
// Offline real-adapter + real-native negative permission check. Only disposable files are targeted.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AcpClient } from "../src/acp-client.js"
import { startOfflineResponsesProvider, offlineProviderConfig } from "./fixtures/offline-responses-provider.mjs"

const arg = (key) => process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3)
const executable = arg("codex")
const archive = arg("archive") || fileURLToPath(new URL("../../.vendor-cache/codex-acp-1.13.1.tgz", import.meta.url))
const exists = async (file) => access(file).then(() => true, () => false)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

async function main() {
  assert.ok(executable && path.isAbsolute(executable), "Supply --codex=/absolute/path/to/native/0.163.0")
  assert.equal(execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 }).trim(), "codex-cli 0.163.0")
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), "93e2f215d9d68eb43afc98f46038eecf973996c0c522a8915249148b6ea35e01")
  const root = await mkdtemp(path.join(tmpdir(), "harness-native-permission-"))
  let client, provider, timer
  try {
    const home = path.join(root, "home"), workspace = path.join(root, "workspace")
    await mkdir(home); await mkdir(workspace)
    const inside = path.join(workspace, "allowed.txt"), outside = path.join(root, "forbidden.txt")
    provider = await startOfflineResponsesProvider({ items: 1, userMarker: "POLICY_PROBE", assistantMarker: "OFFLINE_POLICY_DONE",
      toolCommands: [
        { command: `printf workspace > ${quote(inside)}` },
        { command: `printf outside > ${quote(outside)}` },
        { command: `printf escalated > ${quote(outside)}`, escalated: true }
      ] })
    await writeFile(path.join(home, "config.toml"), offlineProviderConfig(provider.baseURL))
    execFileSync("tar", ["-xzf", archive, "-C", root, "package/dist/index.js", "package/package.json"])
    const native = path.join(root, "native")
    // Small controlled fixture only. Bound native address space and CPU time without imposing an
    // invalid RLIMIT_NPROC on the shared UID. Whole-instance cgroup proof remains a Docker gate.
    await writeFile(native, `#!/bin/sh\nexec prlimit --as=1073741824 --cpu=10 -- ${quote(executable)} "$@"\n`)
    await chmod(native, 0o755)
    client = new AcpClient({ command: process.execPath,
      args: ["--v8-pool-size=1", "--max-old-space-size=96", fileURLToPath(new URL("../src/codex-adapter-entry.js", import.meta.url)), path.join(root, "package/dist/index.js")],
      cwd: workspace, authenticate: false,
      environment: { CODEX_PATH: native, HOME: home, CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_CONFIG: "", TOKIO_WORKER_THREADS: "2", RAYON_NUM_THREADS: "1" } })
    timer = setTimeout(() => { void client.close() }, 30000)
    await client.start(5000)
    const session = await client.request("session/new", { cwd: workspace, mcpServers: [] }, 5000)
    await client.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "POLICY_PROBE" }] }, 25000)
    const outputs = provider.requests.flatMap((request) => request.toolOutputs ?? [])
    assert.ok(provider.requests.length >= 4, "native must consume all three command attempts")
    assert.ok(outputs.some((text) => /approval policy.*[Nn]ever|[Nn]ever.*(approval|escalat)|escalat.*(not allowed|reject|denied)/i.test(text)), "must observe native policy rejection, not only an invalid tool call")
    assert.equal(await exists(outside), false, "neither sandbox nor explicit escalation may write outside the workspace")
    console.log(JSON.stringify({ status: "passed_native_escalation_denied", native: "0.163.0", realAdapter: "1.13.1", providerRequests: provider.requests.length,
      workspaceWriteSucceeded: await exists(inside), outsideFileCreated: false, nativeNeverRejectionObserved: true, kernelSandboxAccepted: false }))
  } finally {
    clearTimeout(timer)
    await client?.close()
    await provider?.close()
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(JSON.stringify({ status: "failed", error: error.message })); process.exitCode = 1 })
