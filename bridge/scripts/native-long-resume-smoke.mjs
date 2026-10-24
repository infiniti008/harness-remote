#!/usr/bin/env node
// Native Codex writes this new fixture itself. Never open an existing agent home or rollout.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { createCodexHistoryLoader } from "../src/codex-session-history.js"
import { startOfflineResponsesProvider, offlineProviderConfig } from "./fixtures/offline-responses-provider.mjs"

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

function connectNative(executable, home, workspace, development) {
  const args = ["app-server", "--listen", "stdio://"]
  const command = development ? "prlimit" : executable
  const child = spawn(command, development ? ["--as=1073741824", "--cpu=10", "--", executable, ...args] : args, {
    detached: true, cwd: workspace, stdio: ["pipe", "pipe", "pipe"],
    // Deliberately do not inherit CODEX_HOME, config, provider routing or account credentials.
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "C.UTF-8", TOKIO_WORKER_THREADS: "2", RAYON_NUM_THREADS: "1" }
  })
  const pending = new Map()
  const events = []
  let sequence = 0
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096) })
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event
    try { event = JSON.parse(line) } catch { return }
    if (Object.hasOwn(event, "id") && pending.has(event.id)) {
      const waiter = pending.get(event.id); pending.delete(event.id); clearTimeout(waiter.timer)
      if (event.error) waiter.reject(new Error(event.error.message))
      else waiter.resolve(event.result)
    } else if (event.method === "turn/completed") events.push(event)
  })
  child.stdin.on("error", () => {})
  const fail = (error) => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }; pending.clear() }
  child.once("error", fail)
  child.once("exit", (code, signal) => fail(new Error(`Native exited (${code ?? signal}); ${stderr}`)))
  return {
    child, events,
    request(method, params) {
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

export async function runNativeLongResumeSmoke(argv = process.argv.slice(2)) {
  const value = (key) => argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
  const executable = value("codex")
  const development = argv.includes("--development-small")
  const items = Number(value("items") || (development ? 40 : 40000))
  const budget = await readNativeSmokeBudget()
  if (!executable || !path.isAbsolute(executable)) throw new Error("Supply --codex=/absolute/path/to/pinned/native/codex")
  if (!Number.isInteger(items) || items < 2 || items > (development ? 64 : 40000)) throw new Error("Invalid bounded fixture item count")
  if (!development && !budget.enforced) {
    console.log(JSON.stringify({ status: "unsupported_budget", reason: "requires cgroup v2 <=1GiB, zero swap, <=1CPU, <=128 PIDs", budget }))
    process.exitCode = 2
    return
  }
  const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: { PATH: process.env.PATH, HOME: "/nonexistent", CODEX_HOME: "/nonexistent" } }).trim()
  if (!development && !/^codex-cli 0\.163\.0$/.test(version)) throw new Error("Native acceptance requires exactly Codex 0.163.0")
  if (development && !/^codex-cli 0\.(156\.1|163\.0)$/.test(version)) throw new Error("Small protocol development requires reviewed Codex 0.156.1 or 0.163.0")
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-native-resume-"))
  const home = path.join(temp, "original-home")
  const snapshot = path.join(temp, "source-rollout.jsonl")
  const workspace = path.join(temp, "workspace")
  const userMarker = `EARLY_USER_${randomUUID()}`
  const assistantMarker = `EARLY_ASSISTANT_${randomUUID()}`
  const children = new Set()
  const started = Date.now()
  let provider
  let watchdog
  let observedRequestCount = 0
  try {
    await mkdir(path.join(home, "tmp"), { recursive: true })
    await mkdir(workspace)
    provider = await startOfflineResponsesProvider({ items, userMarker, assistantMarker })
    await writeFile(path.join(home, "config.toml"), offlineProviderConfig(provider.baseURL))
    watchdog = setTimeout(() => { for (const child of children) { try { process.kill(-child.pid, "SIGKILL") } catch {} } }, development ? 30000 : 180000)
    const native = connectNative(executable, home, workspace, development)
    children.add(native.child)
    await native.initialize()
    const created = await native.request("thread/start", { cwd: workspace, model: "fixture-model", modelProvider: "offline_fixture", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" })
    const threadID = created.thread.id
    const turn = await native.request("turn/start", { threadId: threadID, input: [{ type: "text", text: userMarker }], approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false } })
    await native.waitTurn(turn.turn.id)
    await native.close(); children.delete(native.child)
    const rollouts = (await filesBelow(path.join(home, "sessions"))).filter((file) => file.endsWith(".jsonl") && file.includes(threadID))
    assert.equal(rollouts.length, 1, "native must create exactly one source rollout")
    const original = await readFile(rollouts[0])
    const originalHash = createHash("sha256").update(original).digest("hex")
    const records = original.toString("utf8").trim().split("\n").map(JSON.parse)
    assert.ok(records.some((record) => record.type === "response_item" && JSON.stringify(record).includes(assistantMarker)), "native persisted assistant context")
    const loader = createCodexHistoryLoader(path.join(home, "sessions"))
    const seen = new Set()
    let page = await loader.page(threadID, { limit: 200 })
    const retained = page.messages.length
    while (true) {
      for (const message of page.messages) { assert.equal(seen.has(message.info.id), false); seen.add(message.info.id) }
      if (!page.before) break
      page = await loader.page(threadID, { limit: 500, before: page.before })
    }
    assert.ok(seen.size >= items, "native-generated display records must match fixture output count")
    if (!development) await assert.rejects(loader(threadID), { code: "HISTORY_READ_LIMIT" })
    await cp(rollouts[0], snapshot)
    observedRequestCount = provider.requests.length
    const resumed = connectNative(executable, home, workspace, development)
    children.add(resumed.child)
    await resumed.initialize()
    const reply = await resumed.request("thread/resume", { threadId: threadID, excludeTurns: true, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" })
    assert.equal(reply.thread.id, threadID)
    assert.ok(!reply.thread.turns?.length, "resume must not return full history")
    const continued = await resumed.request("turn/start", { threadId: threadID, input: [{ type: "text", text: "Continue using original native context" }], approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false } })
    await resumed.waitTurn(continued.turn.id)
    await resumed.close(); children.delete(resumed.child)
    const contextRequest = provider.requests.slice(observedRequestCount).find((request) => request.userMarker && request.assistantMarker)
    assert.ok(contextRequest, "offline resumed Responses input must contain early user AND assistant native context")
    assert.equal(createHash("sha256").update(await readFile(snapshot)).digest("hex"), originalHash, "frozen source snapshot must remain byte-identical")
    const continuedRollout = await readFile(rollouts[0])
    assert.ok(continuedRollout.length > original.length, "native continuation must append new records")
    assert.ok(continuedRollout.subarray(0, original.length).equals(original), "native continuation must preserve every existing rollout byte")
    const memoryPeak = budget.enforced ? Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim()) : null
    console.log(JSON.stringify({ status: development ? "development_passed_not_acceptance" : "passed", version, items, nativeRecords: records.length, displayMessages: seen.size, seedMessages: retained, originalSHA256: originalHash, originalPrefixUnchanged: true, snapshotUnchanged: true, resumedNativeContext: true, providerRequests: provider.requests.length, elapsedMs: Date.now() - started, memoryPeak, budget }))
  } finally {
    clearTimeout(watchdog)
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL") } catch {} }
    await provider?.close()
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeLongResumeSmoke().catch((error) => { console.error(JSON.stringify({ status: "failed", error: error.message })); process.exitCode = 1 })
}
