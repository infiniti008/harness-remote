#!/usr/bin/env node
// Native Codex writes this new fixture itself. Never open an existing agent home or rollout.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"
import { inspectCodexIndex } from "../src/codex-index-preflight.js"
import { startOfflineResponsesProvider, offlineProviderConfig } from "./fixtures/offline-responses-provider.mjs"
import { continueThroughOfflineGateway } from "./fixtures/offline-gateway-continuation.mjs"

export async function readNativeSmokeBudget(root = "/sys/fs/cgroup") {
  try {
    const [memory, swap, pids, cpu] = await Promise.all(["memory.max", "memory.swap.max", "pids.max", "cpu.max"].map((file) => readFile(path.join(root, file), "utf8")))
    const [quota, period] = cpu.trim().split(/\s+/).map(Number)
    const budget = { memory: Number(memory.trim()), swap: Number(swap.trim()), pids: Number(pids.trim()), cpuQuota: quota / period }
    return { ...budget, enforced: budget.memory > 0 && budget.memory <= 1024 ** 3 && budget.swap === 0 && budget.pids > 0 && budget.pids <= 128 && budget.cpuQuota > 0 && budget.cpuQuota <= 1 }
  } catch { return { enforced: false } }
}

async function filesBelow(directory) {
  const files = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) files.push(...await filesBelow(file))
    else if (item.isFile()) files.push(file)
  }
  return files
}

export async function nativeSmokeResources(pids = [], cgroup = "/sys/fs/cgroup", proc = "/proc") {
  const resources = { processes: [] }
  await Promise.all(["memory.current", "memory.peak", "memory.events", "pids.current", "pids.peak", "pids.events", "cpu.stat"].map(async (file) => {
    try { resources[file] = (await readFile(path.join(cgroup, file), "utf8")).trim().slice(0, 1024) } catch {}
  }))
  // Process names, parent IDs and resource totals only: never command lines or environments.
  const entries = await readdir(proc).catch(() => [])
  const processes = (await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    try {
      const status = await readFile(path.join(proc, entry, "status"), "utf8")
      const field = (name) => status.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
      return { pid: Number(entry), parent: Number(field("PPid")), name: field("Name"), threads: Number(field("Threads")), rssKiB: Number(field("VmRSS")?.split(/\s+/)[0] || 0) }
    } catch { return null }
  }))).filter(Boolean)
  const owned = new Set([process.pid, ...pids])
  for (let index = 0; index < processes.length; index++) {
    const before = owned.size
    for (const item of processes) if (owned.has(item.parent)) owned.add(item.pid)
    if (before === owned.size) break
  }
  resources.processes = await Promise.all(processes.filter((item) => owned.has(item.pid)).slice(0, 32).map(async (item) => {
    const threadNames = Object.create(null)
    const tasks = await readdir(path.join(proc, String(item.pid), "task")).catch(() => [])
    await Promise.all(tasks.slice(0, 256).map(async (task) => {
      try {
        const name = (await readFile(path.join(proc, String(item.pid), "task", task, "comm"), "utf8")).trim().slice(0, 32)
        if (Object.keys(threadNames).length < 32 || Object.hasOwn(threadNames, name)) threadNames[name] = (threadNames[name] || 0) + 1
      } catch {}
    }))
    return { ...item, threadNames }
  }))
  return resources
}

async function validateArtifactsDirectory(directory) {
  if (!path.isAbsolute(directory) || !(await stat(directory).catch(() => undefined))?.isDirectory()) throw new Error("--artifacts-dir must name an absolute existing directory")
}

export async function preserveNativeSmokeFailure(temp, diagnostics, artifactsParent) {
  if (artifactsParent !== undefined) await validateArtifactsDirectory(artifactsParent)
  const directory = artifactsParent === undefined
    ? path.join(temp, "failure-artifacts")
    : await mkdtemp(path.join(artifactsParent, "harness-native-resume-failure-"))
  if (artifactsParent === undefined) await mkdir(directory, { mode: 0o700 })
  const rollouts = (await filesBelow(path.join(temp, "original-home", "sessions")).catch(() => [])).filter((file) => file.endsWith(".jsonl")).slice(0, 2)
  const files = []
  // At most 8 MiB of exclusively synthetic rollout bytes, plus bounded diagnostics. Never
  // retain the HOME/config/database wholesale, or copy account/credential/log directories.
  for (const [index, source] of rollouts.entries()) {
    const handle = await open(source, "r")
    try {
      const { size } = await handle.stat()
      const ranges = size <= 4 * 1024 ** 2 ? [[0, size, "full"]] : [[0, 2 * 1024 ** 2, "head"], [size - 2 * 1024 ** 2, 2 * 1024 ** 2, "tail"]]
      for (const [offset, length, part] of ranges) {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        const name = `rollout-${index}-${part}.jsonl`
        await writeFile(path.join(directory, name), buffer.subarray(0, bytesRead), { mode: 0o600, flag: "wx" })
        files.push({ name, sourceBytes: size, offset, bytes: bytesRead })
      }
    } finally { await handle.close() }
  }
  await writeFile(path.join(directory, "diagnostics.json"), JSON.stringify({ ...diagnostics, files }, null, 2), { mode: 0o600, flag: "wx" })
  return directory
}

export async function inspectNativeRollout(file, assistantMarker, bytes) {
  const hash = createHash("sha256")
  let records = 0
  let assistantContext = false
  const stream = createReadStream(file, bytes === undefined ? {} : { end: bytes - 1 })
  stream.on("data", (chunk) => hash.update(chunk))
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue
    const record = JSON.parse(line)
    records++
    if (record.type === "response_item" && line.includes(assistantMarker)) assistantContext = true
  }
  return { sha256: hash.digest("hex"), records, assistantContext }
}

function connectNative(executable, home, workspace, development) {
  const args = ["app-server", "--listen", "stdio://"]
  const command = development ? "prlimit" : executable
  const child = spawn(command, development ? ["--as=1073741824", "--cpu=10", "--", executable, ...args] : args, {
    detached: true, cwd: workspace, stdio: ["pipe", "pipe", "pipe"],
    // Deliberately do not inherit CODEX_HOME, config, provider routing or account credentials.
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "C.UTF-8", TOKIO_WORKER_THREADS: "2", RAYON_NUM_THREADS: "1", UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "--v8-pool-size=1 --max-old-space-size=32 --disable-wasm-trap-handler", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" }
  })
  const pending = new Map()
  const events = []
  let sequence = 0
  let stderr = ""
  const metrics = { receivedLines: 0, receivedBytes: 0, notifications: {}, requests: {}, warnings: [] }
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096) })
  createInterface({ input: child.stdout }).on("line", (line) => {
    metrics.receivedLines++
    metrics.receivedBytes += Buffer.byteLength(line) + 1
    let event
    try { event = JSON.parse(line) } catch { return }
    if (Object.hasOwn(event, "id") && pending.has(event.id)) {
      const waiter = pending.get(event.id); pending.delete(event.id); clearTimeout(waiter.timer)
      if (event.error) waiter.reject(new Error(event.error.message))
      else waiter.resolve(event.result)
    } else if (event.method) {
      if (Object.keys(metrics.notifications).length < 64 || Object.hasOwn(metrics.notifications, event.method)) metrics.notifications[event.method] = (metrics.notifications[event.method] || 0) + 1
      if (event.method === "warning" && metrics.warnings.length < 8) metrics.warnings.push(JSON.stringify(event.params).slice(0, 2048))
      if (event.method === "turn/completed") {
        const { id, status, error } = event.params.turn
        // Native includes every item in its completed-turn notification. Keep only the
        // completion signal; retaining its 40k-item payload duplicates the fixture history.
        events.push({ params: { turn: { id, status, error } } })
      }
    }
  })
  child.stdin.on("error", () => {})
  const fail = (error) => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }; pending.clear() }
  child.once("error", fail)
  child.once("exit", (code, signal) => fail(new Error(`Native exited (${code ?? signal}); ${stderr}`)))
  return {
    child, events, metrics,
    get stderr() { return stderr },
    request(method, params) {
      metrics.requests[method] = (metrics.requests[method] || 0) + 1
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native ${method} timed out; ${stderr}`)) }, development ? 20000 : 120000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
      })
    },
    async initialize() {
      await this.request("initialize", { clientInfo: { name: "harness-offline-native-fixture", version: "1" }, capabilities: { experimentalApi: true } })
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n")
    },
    async waitTurn(turnID) {
      const deadline = Date.now() + (development ? 20000 : 120000)
      while (Date.now() < deadline) {
        const event = events.find((item) => item.params.turn.id === turnID)
        if (event) { assert.equal(event.params.turn.status, "completed", JSON.stringify(event.params.turn.error)); return }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Native stopped during turn; ${stderr}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`Native turn timed out; ${stderr}`)
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, "exit")
      child.stdin.end()
      const kill = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 1000)
      await exited.catch(() => {})
      clearTimeout(kill)
    }
  }
}

export async function runNativeLongResumeSmoke(argv = process.argv.slice(2), { mcpProbe } = {}) {
  const value = (key) => argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
  const executable = value("codex")
  const development = argv.includes("--development-small")
  const gatewayContinuation = argv.includes("--gateway-continuation")
  const items = Number(value("items") || (development ? 40 : 40000))
  if (mcpProbe) assert.ok(development && gatewayContinuation && items === 2, "readonly MCP probe is an isolated two-item development case")
  const messageStream = value("message-stream") || "completed"
  const artifactsParent = value("artifacts-dir")
  if (artifactsParent !== undefined) await validateArtifactsDirectory(artifactsParent)
  if (!["completed", "deltas"].includes(messageStream)) throw new Error("Use --message-stream=completed or deltas")
  const budget = await readNativeSmokeBudget()
  if (!executable || !path.isAbsolute(executable)) throw new Error("Supply --codex=/absolute/path/to/pinned/native/codex")
  if (!Number.isInteger(items) || items < 2 || items > (development ? 64 : 40000)) throw new Error("Invalid bounded fixture item count")
  if (!development && !budget.enforced) {
    console.log(JSON.stringify({ status: "unsupported_budget", reason: "requires cgroup v2 <=1GiB, zero swap, <=1CPU, <=128 PIDs", budget }))
    process.exitCode = 2
    return
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-native-resume-"))
  const home = path.join(temp, "original-home")
  const snapshot = path.join(temp, "source-rollout.jsonl")
  const workspace = path.join(temp, "workspace")
  const userMarker = `EARLY_USER_${randomUUID()}`
  const assistantMarker = `EARLY_ASSISTANT_${randomUUID()}`
  const continuationMarker = `GATEWAY_ASSISTANT_${randomUUID()}`
  let releaseCompletion
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve })
  const gateway = {}
  const children = new Set()
  const started = Date.now()
  let provider
  let watchdog
  let progress
  let samplePending = false
  let artifacts
  let version
  let phase = "setup"
  let phaseStarted = started
  const phases = []
  const samples = []
  const natives = []
  let pages = 0
  let displayed = 0
  let observedRequestCount = 0
  const enter = (next) => {
    phases.push({ phase, elapsedMs: Date.now() - phaseStarted })
    phase = next; phaseStarted = Date.now()
    console.error(JSON.stringify({ status: "progress", phase, elapsedMs: Date.now() - started }))
  }
  const diagnostic = () => ({ phase, phaseElapsedMs: Date.now() - phaseStarted, elapsedMs: Date.now() - started, version, items, messageStream, budget, phases, pages, displayed, provider: provider?.requests, native: natives.map((native) => ({ pid: native.child.pid, metrics: native.metrics, stderrTail: native.stderr })), ...(gatewayContinuation ? { gateway } : {}), samples })
  const sample = async () => {
    if (samplePending) return
    samplePending = true
    try {
      const resources = await nativeSmokeResources([...children].map((child) => child.pid))
      resources.rolloutBytes = await Promise.all((await filesBelow(path.join(home, "sessions")).catch(() => [])).filter((file) => file.endsWith(".jsonl")).slice(0, 2).map(async (file) => (await stat(file)).size))
      samples.push({ elapsedMs: Date.now() - started, phase, ...resources })
      if (samples.length > 24) samples.shift()
      console.error(JSON.stringify({ status: "progress", phase, phaseElapsedMs: Date.now() - phaseStarted, elapsedMs: Date.now() - started, resources, pages, displayed, provider: provider?.requests, native: natives.map((native) => native.metrics), ...(gatewayContinuation ? { gateway } : {}) }))
    } finally { samplePending = false }
  }
  try {
    await mkdir(path.join(home, "tmp"), { recursive: true })
    await mkdir(workspace)
    // Version probing uses the same private HOME as native; even this subprocess must not
    // consult inherited account configuration or write aliases to the user's real HOME.
    version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: path.join(home, "tmp") } }).trim()
    if (!development && !/^codex-cli 0\.163\.0$/.test(version)) throw new Error("Native acceptance requires exactly Codex 0.163.0")
    if (development && !/^codex-cli 0\.(156\.1|163\.0)$/.test(version)) throw new Error("Small protocol development requires reviewed Codex 0.156.1 or 0.163.0")
    if (mcpProbe) assert.equal(version, "codex-cli 0.163.0", "MCP gateway proof requires pinned native 0.163.0")
    provider = await startOfflineResponsesProvider({ items, userMarker, assistantMarker, messageStream,
      ...(mcpProbe ? { toolCommands: [null, { mcpTool: "mcp__readonly_fixture__read_marker" }] } : {}),
      ...(gatewayContinuation ? { continuationMarker, continuationMessageStream: "deltas", beforeComplete: async (summary) => { if (summary.sequence > (mcpProbe ? 2 : 1)) await completionGate } } : {}) })
    await writeFile(path.join(home, "config.toml"), offlineProviderConfig(provider.baseURL))
    progress = setInterval(() => { sample().catch(() => {}) }, 5000)
    watchdog = setTimeout(() => { for (const child of children) { try { child.fixtureGraceful ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGKILL") } catch {} } }, development ? 30000 : 180000)
    enter("seed_initialize")
    const native = connectNative(executable, home, workspace, development)
    natives.push(native)
    children.add(native.child)
    await native.initialize()
    enter("seed_thread_start")
    const created = await native.request("thread/start", { cwd: workspace, model: "fixture-model", modelProvider: "offline_fixture", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" })
    const threadID = created.thread.id
    enter("seed_turn_start")
    const turn = await native.request("turn/start", { threadId: threadID, input: [{ type: "text", text: userMarker }], approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false } })
    enter("seed_turn_drain")
    await sample()
    await native.waitTurn(turn.turn.id)
    if (gatewayContinuation) {
      enter("native_index_backfill")
      const deadline = Date.now() + (development ? 20000 : 120000)
      while (!(await inspectCodexIndex(home, { sqliteHome: home })).ready) {
        assert.ok(Date.now() < deadline, "actual native index backfill must finish before gateway startup")
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      gateway.nativeIndexReady = true
    }
    enter("seed_shutdown")
    await native.close(); children.delete(native.child)
    enter("source_validation")
    const rollouts = (await filesBelow(path.join(home, "sessions"))).filter((file) => file.endsWith(".jsonl") && file.includes(threadID))
    assert.equal(rollouts.length, 1, "native must create exactly one source rollout")
    const originalBytes = (await stat(rollouts[0])).size
    const original = await inspectNativeRollout(rollouts[0], assistantMarker)
    const originalHash = original.sha256
    assert.ok(original.assistantContext, "native persisted assistant context")
    const loader = createCodexHistoryLoader(path.join(home, "sessions"))
    const seen = new Set()
    let page = await loader.page(threadID, { limit: 200 })
    const retained = page.messages.length
    while (true) {
      pages++
      for (const message of page.messages) { assert.equal(seen.has(message.info.id), false); seen.add(message.info.id) }
      displayed = seen.size
      if (!page.before) break
      page = await loader.page(threadID, { limit: 500, before: page.before })
    }
    assert.ok(seen.size >= items, "native-generated display records must match fixture output count")
    if (!development) await assert.rejects(loader(threadID), { code: "HISTORY_READ_LIMIT" })
    await cp(rollouts[0], snapshot)
    observedRequestCount = provider.requests.length
    if (gatewayContinuation) {
      if (mcpProbe) {
        const config = path.join(home, "config.toml")
        await writeFile(config, `${await readFile(config, "utf8")}\n[mcp_servers.readonly_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(["--v8-pool-size=1", "--max-old-space-size=32", "--disable-wasm-trap-handler", mcpProbe.serverScript, mcpProbe.marker])}\nrequired = true\nenabled_tools = ["read_marker"]\nstartup_timeout_sec = 5\ntool_timeout_sec = 5\n`)
      }
      await continueThroughOfflineGateway({ temp, home, workspace, executable, development, archive: value("archive"), threadID, originalMessages: seen.size,
        continuationMarker, provider, releaseCompletion, children, enter, diagnostics: gateway, mcpProbe })
      enter("continuation_validation")
    } else {
      enter("resume_initialize")
      const resumed = connectNative(executable, home, workspace, development)
      natives.push(resumed)
      children.add(resumed.child)
      await resumed.initialize()
      enter("native_resume")
      const reply = await resumed.request("thread/resume", { threadId: threadID, excludeTurns: true, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" })
      assert.equal(reply.thread.id, threadID)
      assert.ok(!reply.thread.turns?.length, "resume must not return full history")
      enter("continuation_start")
      const continued = await resumed.request("turn/start", { threadId: threadID, input: [{ type: "text", text: "Continue using original native context" }], approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false } })
      enter("continuation_drain")
      await resumed.waitTurn(continued.turn.id)
      enter("continuation_validation")
      await resumed.close(); children.delete(resumed.child)
    }
    const contextRequest = provider.requests.slice(observedRequestCount).find((request) => request.userMarker && request.assistantMarker)
    assert.ok(contextRequest, "offline resumed Responses input must contain early user AND assistant native context")
    assert.equal((await inspectNativeRollout(snapshot, assistantMarker)).sha256, originalHash, "frozen source snapshot must remain byte-identical")
    assert.ok((await stat(rollouts[0])).size > originalBytes, "native continuation must append new records")
    assert.equal((await inspectNativeRollout(rollouts[0], assistantMarker, originalBytes)).sha256, originalHash, "native continuation must preserve every existing rollout byte")
    const memoryPeak = budget.enforced ? Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim()) : null
    enter("complete")
    console.log(JSON.stringify({ status: mcpProbe ? "passed_offline_readonly_mcp" : development ? "development_passed_not_acceptance" : "passed", version, items, messageStream, nativeRecords: original.records, originalBytes, displayMessages: seen.size, seedMessages: retained, originalSHA256: originalHash, originalPrefixUnchanged: true, snapshotUnchanged: true, resumedNativeContext: true, providerRequests: provider.requests.length, provider: provider.requests, native: natives.map((native) => native.metrics), ...(gatewayContinuation ? { gateway } : {}), phases, elapsedMs: Date.now() - started, memoryPeak, budget }))
  } catch (error) {
    releaseCompletion()
    clearInterval(progress)
    await sample().catch(() => {})
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL") } catch {} }
    await Promise.all(natives.map((native) => native.close().catch(() => {})))
    await provider?.close()
    artifacts = await preserveNativeSmokeFailure(temp, { ...diagnostic(), error: error.message }, artifactsParent).catch(() => undefined)
    error.message = `${error.message}; phase=${phase}; artifacts=${artifacts || "unavailable"}`
    throw error
  } finally {
    clearInterval(progress)
    clearTimeout(watchdog)
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL") } catch {} }
    await provider?.close()
    if (artifacts && artifactsParent === undefined) {
      // Keep only the explicit bounded artifact allowlist; destroy the fixture HOME itself.
      for (const entry of await readdir(temp)) if (entry !== "failure-artifacts") await rm(path.join(temp, entry), { recursive: true, force: true })
    } else await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeLongResumeSmoke().catch((error) => { console.error(JSON.stringify({ status: "failed", error: error.message })); process.exitCode = 1 })
}
