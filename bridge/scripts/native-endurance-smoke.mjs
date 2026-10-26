#!/usr/bin/env node
// Disposable native/ACP/gateway probe. Never reads an existing Codex home or login.
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import { once } from "node:events"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { AcpClient } from "../src/acp-client.js"
import { inspectCodexIndex } from "../src/codex-index-preflight.js"
import { stageOfflineGateway } from "./fixtures/offline-gateway-continuation.mjs"
import { offlineProviderConfig } from "./fixtures/offline-responses-provider.mjs"
import { readNativeSmokeBudget } from "./native-long-resume-smoke.mjs"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`

async function processInfo(pid) {
  try {
    const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8")])
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)
    const field = (name) => status.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
    return { pid, parent: Number(fields[1]), startTime: fields[19], name: field("Name"), threads: Number(field("Threads")), rssKiB: Number(field("VmRSS")?.split(/\s+/)[0] || 0) }
  } catch { return undefined }
}

async function cgroupResources() {
  const result = {}
  for (const name of ["pids.current", "pids.peak", "pids.events", "memory.current", "memory.peak", "memory.events"]) {
    try { result[name] = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim() } catch {}
  }
  return result
}

export async function runNativeEndurance(argv = process.argv.slice(2)) {
  const value = (key) => argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3)
  const development = argv.includes("--development-small")
  const executable = value("codex")
  const cycles = Number(value("cycles") || 20)
  const pauseMs = Number(value("pause-ms") || 65000)
  const artifacts = value("artifacts-dir")
  assert.ok(executable && path.isAbsolute(executable), "Supply an absolute pinned --codex path")
  assert.ok(artifacts && path.isAbsolute(artifacts), "Supply an existing private --artifacts-dir")
  assert.ok((await stat(artifacts)).isDirectory(), "Artifact directory must already exist")
  assert.ok(Number.isInteger(cycles) && cycles >= 2 && cycles <= 20)
  assert.ok(Number.isInteger(pauseMs) && pauseMs >= 1000 && pauseMs <= 70000)
  const budget = await readNativeSmokeBudget()
  if (!development && !budget.enforced) throw new Error("requires <=1GiB/no-swap/1CPU/128PID cgroup; shared-host development needs --development-small")
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-native-endurance-"))
  const home = path.join(temp, "home"), workspace = path.join(temp, "workspace")
  await mkdir(home); await mkdir(workspace); await mkdir(path.join(home, "tmp"))
  const report = { status: "running", budget, cycles: [], pauseMs, startedAt: new Date().toISOString(), samples: 0 }
  const plans = []
  let phase = "setup", gateway, boot, provider, base, threadID, sampler, sampling = false, sampleFile
  let sampleTail = Promise.resolve()
  const tracked = new Map()
  let gatewayStderr = "", gatewayExited = false, abortExpired = false
  const sseStreams = new Set()
  const deadline = Date.now() + 180000
  const remaining = () => { assert.ok(!abortExpired && Date.now() < deadline, "180s watchdog expired"); return deadline - Date.now() }
  const note = (next, detail = {}) => { phase = next; console.error(JSON.stringify({ phase, ...detail })) }
  const plan = (kind, label, options = {}) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const p = { marker: `PROBE_${label}_${randomUUID().replaceAll("-", "")}`, kind, gate, release, requests: 0, completed: false, closed: false, ...options }
    plans.push(p); return p
  }
  const readJSON = async (route, options = {}) => {
    remaining()
    const response = await fetch(base + route, { ...options, headers: { Authorization: authorization, "Content-Type": "application/json" }, signal: AbortSignal.timeout(Math.min(remaining(), 10000)) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 1500)); return body
  }
  const password = randomUUID(), authorization = `Basic ${Buffer.from(`endurance:${password}`).toString("base64")}`
  const scoped = "/v1/agents/codex"
  const route = () => `${scoped}/session/${threadID}`
  const status = async () => (await readJSON(`${scoped}/session/status`))[threadID]?.type
  const diagnostics = () => readJSON("/v1/diagnostics")
  const prompts = (d) => d.agents.find((a) => a.id === "codex")?.process?.pendingRequests?.filter((r) => r.method === "session/prompt") ?? []
  // Capture before releasing a held response or shutting down: teardown used to erase the very
  // pending state needed to distinguish a stuck NEXT from an unconfirmed Stop. No transcript,
  // native argv/environment, model input, authentication headers or raw error bodies are saved.
  const captureState = async (label) => {
    const get = async (endpoint) => {
      try {
        const response = await fetch(base + endpoint, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(1500) })
        return response.ok ? await response.json() : { httpStatus: response.status }
      } catch (error) { return { unavailable: true, errorName: error.name } }
    }
    const [diag, statuses, native] = await Promise.all([get("/v1/diagnostics"), get(`${scoped}/session/status`), get(`${route()}/execution`)])
    const process = diag.agents?.find((agent) => agent.id === "codex")?.process
    const service = diag.services?.codex
    const pick = (source, keys) => source && Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
    return { label, phase, at: new Date().toISOString(), gatewayExited,
      process: pick(process, ["state", "processID", "startInFlight", "pendingRequestCount", "oldestPendingMs", "pendingRequests"]),
      service: pick(service, ["activeSessions", "queuedSessions", "inFlightLoads", "snapshotWrites", "promptIdleTimeoutMs"]),
      sessionStatus: statuses[threadID],
      nativeExecution: native,
      diagnosticsUnavailable: pick(diag, ["httpStatus", "unavailable", "errorName"]),
      statusUnavailable: pick(statuses, ["httpStatus", "unavailable", "errorName"]),
      ...(budget.enforced ? { cgroup: await cgroupResources() } : {}) }
  }
  const until = async (fn, limit = 10000) => {
    const end = Date.now() + Math.min(limit, remaining())
    while (Date.now() < end) { if (await fn()) return; await delay(25) }
    throw new Error(`Timed out in ${phase}`)
  }
  const send = (p) => readJSON(`${route()}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: p.marker }] }) })
  const messages = () => readJSON(`${route()}/message?limit=200`)
  const textIncludes = (rows, text) => rows.some((m) => m.parts?.some((part) => part.text?.includes(text)))
  const collect = async (label) => {
    const rows = (await Promise.all((await readdir("/proc")).filter((n) => /^\d+$/.test(n)).map((n) => processInfo(Number(n))))).filter(Boolean)
    const selected = new Set(rows.filter((p) => tracked.get(p.pid) === p.startTime).map((p) => p.pid))
    for (let i = 0; i < rows.length; i++) {
      const before = selected.size
      for (const p of rows) if (selected.has(p.parent)) selected.add(p.pid)
      if (before === selected.size) break
    }
    assert.ok(selected.size <= 128, "owned process count exceeds diagnostic budget; refusing truncated totals")
    const processes = []
    for (const p of rows.filter((p) => selected.has(p.pid))) {
      const threadNames = Object.create(null)
      for (const tid of await readdir(`/proc/${p.pid}/task`).catch(() => [])) {
        try { const name = (await readFile(`/proc/${p.pid}/task/${tid}/comm`, "utf8")).trim().slice(0, 48); threadNames[name] = (threadNames[name] || 0) + 1 } catch {}
      }
      const after = await processInfo(p.pid)
      if (!after || after.startTime !== p.startTime || after.parent !== p.parent) continue
      tracked.set(p.pid, p.startTime)
      processes.push({ ...p, threadNames })
    }
    const row = { elapsedMs: 180000 - (deadline - Date.now()), phase: label, gatewayPid: gateway?.pid,
      tasks: processes.reduce((n, p) => n + p.threads, 0), rssKiB: processes.reduce((n, p) => n + p.rssKiB, 0), processCount: processes.length, processes }
    if (budget.enforced) Object.assign(row, await cgroupResources())
    assert.ok(report.samples < 1900, "sample count exceeded budget")
    await sampleFile.write(`${JSON.stringify(row)}\n`); report.samples++
    if (!report.peak || row.tasks > report.peak.tasks) report.peak = row
    if (!report.rssPeakKiB || row.rssKiB > report.rssPeakKiB) report.rssPeakKiB = row.rssKiB
    return row
  }
  const snapshot = (label = phase) => {
    const pending = sampleTail.then(() => collect(label))
    sampleTail = pending.catch(() => {})
    return pending
  }
  const idleSample = async (label) => { await until(async () => await status() === "idle" && prompts(await diagnostics()).length === 0); await delay(250); return snapshot(label) }
  const quick = async (label) => {
    note("next_submit", { label })
    const p = plan("quick", label); await send(p)
    note("next_wait", { label })
    await until(async () => await status() === "idle" && textIncludes(await messages(), `DONE_${p.marker}`))
    assert.equal(p.requests, 1, "a next prompt must issue exactly one provider request")
    return p
  }
  const openSSE = async () => {
    const controller = new AbortController()
    const response = await fetch(base + `${scoped}/global/event`, { headers: { Authorization: authorization }, signal: controller.signal })
    assert.equal(response.status, 200)
    const state = { controller, events: 0, ended: false }
    state.task = (async () => { try { for await (const chunk of response.body) state.events += (new TextDecoder().decode(chunk).match(/data: /g) || []).length } catch (error) { if (!controller.signal.aborted) throw error } finally { state.ended = true } })()
    state.task.catch(() => {})
    sseStreams.add(state); return state
  }
  const closeSSE = async (state) => { state.controller.abort(); await state.task; sseStreams.delete(state) }
  const stopGateway = async () => {
    if (!gateway) return
    if (sampleFile) await snapshot("before_shutdown").catch((e) => { report.samplingError = e.message })
    if (!gatewayExited) {
      const child = gateway, exited = once(child, "exit").catch(() => {})
      child.kill("SIGTERM")
      const force = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 5000)
      await exited; clearTimeout(force)
    }
    const alive = async () => (await Promise.all([...tracked].map(async ([pid, birth]) => {
      const p = await processInfo(pid); return p?.startTime === birth ? p : undefined
    }))).filter(Boolean)
    let remaining = await alive()
    for (let i = 0; remaining.length && i < 20; i++) { await delay(50); remaining = await alive() }
    if (remaining.length) {
      report.cleanupFailures ??= []; report.cleanupFailures.push(remaining)
      for (const p of remaining) if ((await processInfo(p.pid))?.startTime === p.startTime) { try { process.kill(p.pid, "SIGKILL") } catch {} }
      await delay(100)
    }
    report.shutdowns ??= []; report.shutdowns.push({ tracked: tracked.size, remainingAfterGrace: remaining.length, remainingAfterCleanup: (await alive()).length })
    for (const [pid, birth] of tracked) if ((await processInfo(pid))?.startTime !== birth) tracked.delete(pid)
  }
  const watchdog = setTimeout(() => { abortExpired = true; for (const p of plans) p.release(); gateway?.kill("SIGTERM") }, 180000)
  try {
    report.initialCgroup = budget.enforced ? await cgroupResources() : undefined
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "C.UTF-8",
      NODE_OPTIONS: "--v8-pool-size=1 --max-old-space-size=96 --disable-wasm-trap-handler", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" }
    assert.equal(execFileSync(executable, ["--version"], { env, encoding: "utf8", timeout: 5000 }).trim(), "codex-cli 0.163.0")
    provider = http.createServer(async (request, response) => {
      let p
      try {
        assert.ok(["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress))
        assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses")
        let raw = ""
        for await (const chunk of request) { raw += chunk.toString(); assert.ok(Buffer.byteLength(raw) < 2 * 1024 ** 2) }
        const body = JSON.parse(raw); assert.equal(body.model, "fixture-model"); assert.equal(body.stream, true)
        p = plans.findLast((item) => raw.includes(item.marker)); assert.ok(p, "unknown provider prompt")
        p.requests++; p.inputBytes = Buffer.byteLength(raw); p.startedAt = Date.now()
        response.once("close", () => { p.closed = true; p.release() })
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        const emit = (event) => { if (!response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`) }
        const responseID = `resp_${plans.indexOf(p)}`, id = `msg_${plans.indexOf(p)}`
        emit({ type: "response.created", response: { id: responseID, object: "response", status: "in_progress", output: [] } })
        const item = { id, type: "message", role: "assistant", phase: "final_answer", status: "in_progress", content: [] }
        emit({ type: "response.output_item.added", output_index: 0, item })
        emit({ type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
        let text = `BEGIN_${p.marker}`
        emit({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text })
        if (p.kind === "hold") await p.gate
        if (p.kind === "progress") for (let i = 0; i < 8; i++) {
          await delay(500); if (response.destroyed) break
          const delta = ` tick${i}`; text += delta; emit({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta })
        }
        if (response.destroyed) return
        const end = ` DONE_${p.marker}`; text += end
        emit({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: end })
        emit({ type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text })
        const part = { type: "output_text", text, annotations: [] }
        emit({ type: "response.content_part.done", item_id: id, output_index: 0, content_index: 0, part })
        emit({ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", content: [part] } })
        emit({ type: "response.completed", response: { id: responseID, object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
        p.completed = true; p.elapsedMs = Date.now() - p.startedAt; response.end()
      } catch (error) {
        report.providerError = error.message
        if (!response.headersSent) response.writeHead(400)
        response.end()
      }
    })
    provider.listen(0, "127.0.0.1"); await once(provider, "listening")
    await writeFile(path.join(home, "config.toml"), offlineProviderConfig(`http://127.0.0.1:${provider.address().port}/v1`))
    const staged = await stageOfflineGateway(path.join(temp, "runtime"), value("archive"))
    report.candidateVersion = staged.version
    const native = path.join(temp, "native")
    await writeFile(native, `#!/bin/sh\nexec prlimit --as=1073741824 --cpu=30 -- ${quote(executable)} "$@"\n`, { mode: 0o700 })
    const runtimeEnv = { ...env, CODEX_PATH: native, ...(development ? { HARNESS_ALLOW_UNBOUNDED_DEVELOPMENT: "1" } : {}) }
    // No Tokio/Rayon/libuv override: measure candidate defaults rather than silently tuning them.
    report.poolOverrides = "none"
    note("bootstrap")
    boot = new AcpClient({ command: process.execPath, args: ["--v8-pool-size=1", "--max-old-space-size=96", path.join(temp, "runtime/bridge/src/codex-adapter-entry.js"), path.join(temp, "runtime/vendor/codex-acp/dist/index.js")], cwd: workspace, authenticate: false, environment: runtimeEnv })
    const seed = plan("quick", "SEED")
    await boot.start(15000)
    threadID = (await boot.request("session/new", { cwd: workspace, mcpServers: [] }, 10000)).sessionId
    await boot.request("session/prompt", { sessionId: threadID, prompt: [{ type: "text", text: seed.marker }] }, 15000)
    await boot.close(); boot = undefined
    await until(async () => (await inspectCodexIndex(home)).ready, 10000)
    const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening")
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve)); base = `http://127.0.0.1:${port}`
    const { open } = await import("node:fs/promises")
    sampleFile = await open(path.join(artifacts, "processes.ndjson"), "wx", 0o600)
    const startGateway = async (idleMs) => {
      gatewayExited = false
      const args = [process.execPath, "--v8-pool-size=1", "--max-old-space-size=128", "--disable-wasm-trap-handler", staged.entry, "--host", "127.0.0.1", "--port", String(port), "--root", workspace, "--state-dir", path.join(temp, "gateway-state"), ...(idleMs ? ["--prompt-idle-timeout", String(idleMs)] : [])]
      gateway = spawn("prlimit", ["--as=1073741824", "--cpu=30", "--", ...args], { cwd: workspace, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...runtimeEnv, HARNESS_REMOTE_USERNAME: "endurance", HARNESS_REMOTE_PASSWORD: password } })
      gateway.stdout.resume() // The real launcher can print a pairing QR; never retain it.
      gateway.stderr.on("data", (chunk) => { gatewayStderr = `${gatewayStderr}${chunk}`.slice(-4096) })
      gateway.once("exit", () => { gatewayExited = true })
      const rootIdentity = await processInfo(gateway.pid)
      assert.ok(rootIdentity, "gateway did not start")
      tracked.set(gateway.pid, rootIdentity.startTime)
      await until(async () => { assert.equal(gatewayExited, false, gatewayStderr); try { return (await readJSON(`${scoped}/v1/health`)).harnessVersion === staged.version } catch { return false } }, 15000)
      const diag = await diagnostics()
      assert.equal(diag.services.codex.promptIdleTimeoutMs, idleMs || 1800000)
    }
    await startGateway()
    sampler = setInterval(async () => { if (sampling) return; sampling = true; try { await snapshot() } catch (e) { report.samplingError = e.message } finally { sampling = false } }, 100)
    await quick("WARM")
    const execution = await readJSON(`${route()}/execution`)
    assert.equal(execution.profile, "core")
    assert.equal(execution.execution.turnStatus, "completed")
    assert.ok(execution.execution.firstOutputAt)
    report.nativeExecution = execution
    report.baseline = await idleSample("baseline")
    for (let i = 0; i < cycles; i++) {
      note("stop_cycle", { cycle: i + 1 })
      const p = plan("hold", `STOP_${i}`)
      await send(p)
      if (i % 2 === 1) await until(() => p.requests === 1)
      await delay([0, 25, 100, 250, 600][i % 5])
      note("stop_confirm", { cycle: i + 1 })
      const stopStarted = Date.now()
      const stopResponse = await readJSON(`${route()}/abort`, { method: "POST", body: "{}" })
      const stopMs = Date.now() - stopStarted
      report.lastConfirmedStop = { cycle: i + 1, stopMs, confirmed: stopResponse === true }
      p.release()
      note("after_stop_idle", { cycle: i + 1 })
      await idleSample(`after_stop_${i + 1}`)
      await quick(`NEXT_${i}`)
      const idle = await idleSample(`after_next_${i + 1}`)
      assert.equal(prompts(await diagnostics()).length, 0)
      report.cycles.push({ cycle: i + 1, stopMs, providerStarted: p.requests > 0, idleTasks: idle.tasks, idleProcessCount: idle.processCount, idleRssKiB: idle.rssKiB })
    }
    report.afterCycles = await idleSample("after_cycles")
    report.activeStopCycles = report.cycles.filter((c) => c.providerStarted).length
    assert.ok(report.activeStopCycles >= Math.floor(cycles / 2), "active-provider cancellation was not exercised")
    note("silent_reconnect", { pauseMs })
    let stream = await openSSE()
    const silent = plan("hold", "SILENT")
    await send(silent)
    await until(async () => textIncludes(await messages(), `BEGIN_${silent.marker}`))
    await closeSSE(stream)
    const silenceStart = Date.now()
    let checks = 0
    while (Date.now() - silenceStart < pauseMs) {
      await delay(Math.min(5000, pauseMs - (Date.now() - silenceStart)))
      assert.equal(await status(), "busy")
      const pending = prompts(await diagnostics())
      assert.equal(pending.length, 1); assert.ok(!pending[0].cancelling)
      assert.equal(pending[0].timeoutMs, 1800000)
      assert.equal(silent.requests, 1); checks++
      if (checks === 2) { stream = await openSSE(); await closeSSE(stream) }
    }
    stream = await openSSE(); silent.release()
    await until(async () => await status() === "idle" && textIncludes(await messages(), `DONE_${silent.marker}`))
    await until(() => stream.events > 0)
    await closeSSE(stream)
    report.silentReconnect = { passed: true, elapsedMs: Date.now() - silenceStart, checks, providerRequests: silent.requests }
    await quick("AFTER_SILENCE")
    note("accelerated_idle_watchdog")
    await stopGateway(); await startGateway(1500)
    assert.equal(report.cleanupFailures, undefined, "first gateway left managed descendants")
    const progress = plan("progress", "PROGRESS")
    await send(progress)
    await until(async () => await status() === "idle" && textIncludes(await messages(), `DONE_${progress.marker}`))
    assert.ok(progress.elapsedMs > 3000 && progress.completed)
    const stalled = plan("hold", "STALLED")
    await send(stalled); await until(() => stalled.requests === 1)
    await until(async () => await status() === "idle" && prompts(await diagnostics()).length === 0)
    assert.ok((await messages()).some((m) => /no session activity/.test(m.info.error?.message || "")))
    stalled.release(); await quick("RECOVERED")
    report.acceleratedIdle = { passed: true, testIdleTimeoutMs: 1500, progressingDurationMs: progress.elapsedMs, timeoutCancelled: true, recovered: true }
    report.final = await idleSample("final")
    assert.equal(report.providerError, undefined)
    assert.equal(report.samplingError, undefined)
    assert.equal(report.afterCycles.processCount, report.baseline.processCount, "managed process count accumulated across Stop cycles")
    assert.ok(report.afterCycles.tasks <= report.baseline.tasks + 4, "idle threads grew beyond warm baseline +4; inspect process samples")
    assert.ok(report.peak.tasks <= 128, "observed gateway tree exceeds 128 tasks even without the driver")
    assert.ok(report.rssPeakKiB < 1024 ** 2, "observed summed gateway RSS exceeds 1 GiB")
    report.status = "passed"
  } catch (error) {
    report.status = "failed"; report.error = error.stack; report.failedPhase = phase; report.gatewayStderr = gatewayStderr
    if (base && gateway && !gatewayExited) {
      report.failureState = await captureState("before_cleanup").catch((failure) => ({ unavailable: true, errorName: failure.name }))
      await snapshot("failure_before_cleanup").catch((failure) => { report.failureSamplingError = failure.name })
      await writeFile(path.join(artifacts, "failure-state.json"), JSON.stringify(report.failureState, null, 2), { mode: 0o600, flag: "wx" })
        .catch((failure) => { report.failureArtifactError = failure.name })
    }
    throw error
  } finally {
    clearTimeout(watchdog); clearInterval(sampler)
    for (const p of plans) p.release()
    for (const s of sseStreams) { s.controller.abort(); await s.task.catch(() => {}) }
    await boot?.close().catch(() => {})
    await stopGateway()
    await sampleTail
    await sampleFile?.close()
    provider?.closeAllConnections()
    if (provider) await new Promise((resolve) => provider.close(resolve))
    report.providerRequests = plans.map(({ marker: _marker, gate: _gate, release: _release, ...rest }) => rest)
    report.finalCgroup = budget.enforced ? await cgroupResources() : undefined
    if (report.cleanupFailures || report.samplingError) { report.status = "failed"; report.error ??= "Sampling or owned-child cleanup failed" }
    if (budget.enforced) {
      const event = (raw, key) => Number(raw?.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1] || 0)
      if (event(report.finalCgroup["pids.events"], "max") > event(report.initialCgroup["pids.events"], "max")
        || event(report.finalCgroup["memory.events"], "oom") > event(report.initialCgroup["memory.events"], "oom")
        || event(report.finalCgroup["memory.events"], "oom_kill") > event(report.initialCgroup["memory.events"], "oom_kill")) {
        report.status = "failed"; report.error ??= "Cgroup PID limit or OOM event during probe"
      }
    }
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" })
    await rm(temp, { recursive: true, force: true })
    console.log(JSON.stringify({ status: report.status, artifacts, failedPhase: report.failedPhase, error: report.error?.split("\n")[0], cycles: report.cycles.length, peakTasks: report.peak?.tasks, baselineTasks: report.baseline?.tasks, afterCyclesTasks: report.afterCycles?.tasks, rssPeakKiB: report.rssPeakKiB, silentReconnect: report.silentReconnect, acceleratedIdle: report.acceleratedIdle, enforcedCgroup: budget.enforced }))
    if (report.status !== "passed" && !report.failedPhase) throw new Error(report.error || "endurance acceptance failed")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runNativeEndurance().catch((error) => { console.error(error.message); process.exitCode = 1 })
