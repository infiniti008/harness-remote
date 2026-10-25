import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CODEX_ADAPTER_SHA256 } from "../../src/codex-adapter-policy.js"

const ARCHIVE_SHA256 = "93e2f215d9d68eb43afc98f46038eecf973996c0c522a8915249148b6ea35e01"
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const pause = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Stage only public candidate code and the checksum-pinned adapter, never a user HOME. */
export async function stageOfflineGateway(root, archive) {
  const source = fileURLToPath(new URL("../../../", import.meta.url))
  const installed = path.join(source, "vendor", "codex-acp")
  const useInstalled = archive === undefined && await access(path.join(installed, "dist", "index.js")).then(() => true, () => false)
  if (useInstalled) assert.equal(createHash("sha256").update(await readFile(path.join(installed, "dist", "index.js"))).digest("hex"), CODEX_ADAPTER_SHA256)
  else {
    archive ??= path.join(source, ".vendor-cache", "codex-acp-1.13.1.tgz")
    assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), ARCHIVE_SHA256, "offline gateway requires the reviewed codex-acp 1.13.1 archive")
  }
  await mkdir(path.join(root, "distribution"), { recursive: true })
  await mkdir(path.join(root, "bridge"))
  await mkdir(path.join(root, "vendor", "codex-acp"), { recursive: true })
  await mkdir(path.join(root, "node_modules"))
  await cp(path.join(source, "package.json"), path.join(root, "package.json"))
  await cp(path.join(source, "distribution", "run.mjs"), path.join(root, "distribution", "run.mjs"))
  await cp(path.join(source, "bridge", "src"), path.join(root, "bridge", "src"), { recursive: true })
  await cp(path.join(source, "node_modules", "qrcode-terminal"), path.join(root, "node_modules", "qrcode-terminal"), { recursive: true })
  if (useInstalled) {
    await cp(path.join(installed, "dist"), path.join(root, "vendor", "codex-acp", "dist"), { recursive: true })
    await cp(path.join(installed, "package.json"), path.join(root, "vendor", "codex-acp", "package.json"))
  } else execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", path.join(root, "vendor", "codex-acp"), "package/dist/index.js", "package/package.json"], { timeout: 5000 })
  return { entry: path.join(root, "distribution", "run.mjs"), version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version }
}

export async function continueThroughOfflineGateway({ temp, home, workspace, executable, development, archive, threadID, originalMessages, continuationMarker, provider, releaseCompletion, children, enter, diagnostics, mcpProbe }) {
  const timeout = development ? 20000 : 120000
  const deadline = Date.now() + timeout
  const remaining = () => {
    const ms = deadline - Date.now()
    assert.ok(ms > 0, "offline gateway continuation phase timed out")
    return ms
  }
  enter("gateway_stage")
  const staged = await stageOfflineGateway(path.join(temp, "candidate-runtime"), archive)
  const reservation = net.createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const native = path.join(temp, "gateway-native")
  await writeFile(native, `#!/bin/sh\nexec ${development ? "prlimit --as=1073741824 --cpu=10 -- " : ""}${quote(executable)} "$@"\n`, { mode: 0o700 })
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`offline-fixture:${password}`).toString("base64")}`
  const base = `http://127.0.0.1:${port}`
  const nodeArgs = ["--v8-pool-size=1", "--max-old-space-size=128", "--disable-wasm-trap-handler", staged.entry,
    "--host", "127.0.0.1", "--port", String(port), "--root", workspace, "--state-dir", path.join(temp, "gateway-state")]
  const gateway = spawn(development ? "prlimit" : process.execPath, development ? ["--as=1073741824", "--cpu=10", "--", process.execPath, ...nodeArgs] : nodeArgs, {
    cwd: workspace, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: home, CODEX_PATH: native,
      TMPDIR: path.join(home, "tmp"), LANG: "C.UTF-8", TOKIO_WORKER_THREADS: "2", RAYON_NUM_THREADS: "1", UV_THREADPOOL_SIZE: "1",
      NODE_OPTIONS: "--v8-pool-size=1 --max-old-space-size=96 --disable-wasm-trap-handler", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
      HARNESS_REMOTE_USERNAME: "offline-fixture", HARNESS_REMOTE_PASSWORD: password }
  })
  gateway.fixtureGraceful = true
  children.add(gateway)
  diagnostics.pid = gateway.pid
  diagnostics.candidateVersion = staged.version
  diagnostics.adapter = "1.13.1"
  diagnostics.stderrTail = ""
  diagnostics.eventCounts = {}
  diagnostics.pagesDuringTurn = 0
  let exited = false
  let spawnError
  gateway.once("error", (error) => { spawnError = error })
  gateway.once("exit", () => { exited = true })
  // The real launcher can print a pairing QR. Drain stdout without retaining credentials.
  gateway.stdout.resume()
  gateway.stderr.on("data", (chunk) => { diagnostics.stderrTail = `${diagnostics.stderrTail}${chunk}`.slice(-4096) })
  const request = async (route, { method = "GET", body, authenticate = true } = {}) => {
    if (exited || spawnError) throw new Error(`Offline gateway stopped: ${spawnError?.message || diagnostics.stderrTail}`)
    const response = await fetch(base + route, { method, headers: { ...(authenticate ? { Authorization: authorization } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(remaining()) })
    return response
  }
  const json = async (route, options) => {
    const response = await request(route, options)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 4096))
    return body
  }
  const route = `/v1/agents/codex/session/${threadID}`
  const streamAbort = new AbortController()
  let streamTask
  try {
    enter("gateway_start")
    while (true) {
      remaining()
      try { if ((await request("/v1/diagnostics")).status === 200) break } catch (error) { if (exited || spawnError) throw error }
      await pause()
    }
    assert.equal((await request("/v1/diagnostics", { authenticate: false })).status, 401, "gateway must reject anonymous HTTP")
    const health = await json("/v1/agents/codex/v1/health")
    assert.equal(health.harnessVersion, staged.version, "actual candidate gateway must report its staged version")
    const sessions = await json("/v1/agents/codex/session")
    assert.ok(sessions.some((session) => session.id === threadID), "actual native index must discover the generated session")
    // Even the compatibility HTTP route seeds a bounded window in the current candidate.
    // The caller independently asserts that a genuine full source-loader read is rejected.
    const compatibilityWindow = await json(`${route}/message`)
    assert.ok(compatibilityWindow.length <= 200, "legacy HTTP reads must remain bounded to the native seed")
    diagnostics.legacyHTTPMessages = compatibilityWindow.length
    diagnostics.legacyHTTPBounded = true
    const stream = await fetch(base + "/v1/agents/codex/global/event", { headers: { Authorization: authorization }, signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(remaining())]) })
    assert.equal(stream.status, 200)
    let streamed = false
    const streamErrors = []
    streamTask = (async () => {
      const decoder = new TextDecoder()
      let buffer = ""
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true })
        assert.ok(buffer.length <= 1024 * 1024, "bounded offline gateway SSE frame")
        let boundary
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) {
            const event = JSON.parse(line.slice(6))
            if (Object.keys(diagnostics.eventCounts).length < 32 || Object.hasOwn(diagnostics.eventCounts, event.type)) diagnostics.eventCounts[event.type] = (diagnostics.eventCounts[event.type] || 0) + 1
            if (event.type === "session.error" && streamErrors.length < 8) streamErrors.push(line.slice(0, 2048))
          }
        }
      }
    })().catch((error) => { if (!streamAbort.signal.aborted) streamErrors.push(error.message) })
    enter("gateway_continuation_start")
    await json(`${route}/prompt_async`, { method: "POST", body: { parts: [{ type: "text", text: "Continue using original native context through the isolated gateway" }] } })
    while (!streamed) {
      remaining()
      assert.equal(streamErrors.length, 0, streamErrors.join("; "))
      // Candidate SSE carries invalidations; clients then fetch a bounded message window.
      // Prove that same event/read path instead of expecting text inside the SSE envelope.
      if (diagnostics.eventCounts["message.updated"] > 0) {
        streamed = (await json(`${route}/message?limit=16`)).some((message) => message.parts?.some((part) => part.text?.includes(continuationMarker)))
      }
      if (!streamed) await pause()
    }
    enter("gateway_page_during_turn")
    const seen = new Set()
    const pageLimit = development ? 16 : 500
    let before
    do {
      remaining()
      assert.equal((await json("/v1/agents/codex/session/status"))[threadID]?.type, "busy", "provider gate must keep the real turn active throughout pagination")
      const response = await request(`${route}/message?limit=${pageLimit}${before ? `&before=${encodeURIComponent(before)}` : ""}`)
      assert.equal(response.status, 200, await response.clone().text())
      const messages = await response.json()
      assert.ok(messages.length <= pageLimit)
      for (const message of messages) {
        assert.equal(seen.has(message.info.id), false, "gateway pagination must not duplicate display IDs")
        seen.add(message.info.id)
      }
      diagnostics.pagesDuringTurn++
      before = response.headers.get("x-next-cursor")
    } while (before)
    assert.equal(seen.size, originalMessages + 2, "gateway must expose all original messages plus live user/assistant exactly once")
    diagnostics.displayMessagesDuringTurn = seen.size
    const tail = await json(`${route}/message?limit=500`)
    assert.ok(tail.length <= 202, "reading older pages must not inflate the owned 200-row seed plus live turn")
    if (mcpProbe) {
      assert.ok(provider.requests.some((request) => request.requestedTool === "mcp__readonly_fixture__read_marker"), "native must advertise the actual configured MCP tool")
      assert.ok(provider.requests.some((request) => request.toolOutputs?.some((output) => output.includes(mcpProbe.marker))), "native MCP output must reach the next provider request")
      assert.ok(tail.some((message) => message.parts?.some((part) => part.type === "tool" && part.state?.status === "completed" && part.state.output?.includes(mcpProbe.marker))), "gateway HTTP must expose the real completed MCP tool and marker")
      diagnostics.readonlyMcpNativeOutput = true
      diagnostics.readonlyMcpHttpToolCompleted = true
    }
    diagnostics.retainedTailMessages = tail.length
    diagnostics.nativeContext = provider.requests.some((request) => request.sequence > 1 && request.userMarker && request.assistantMarker)
    assert.equal(diagnostics.nativeContext, true)
    assert.equal(streamErrors.length, 0, streamErrors.join("; "))
    releaseCompletion()
    enter("gateway_continuation_drain")
    while ((await json("/v1/agents/codex/session/status"))[threadID]?.type !== "idle") { remaining(); await pause() }
    diagnostics.streamedAssistant = streamed
    diagnostics.authenticatedHTTP = true
    diagnostics.passed = true
    return diagnostics
  } finally {
    releaseCompletion()
    streamAbort.abort()
    await streamTask
    if (!exited && !spawnError) {
      const stopped = once(gateway, "exit").catch(() => {})
      gateway.kill("SIGTERM")
      const force = setTimeout(() => { try { process.kill(-gateway.pid, "SIGKILL") } catch {} }, 5000)
      await stopped
      clearTimeout(force)
    }
    children.delete(gateway)
  }
}
