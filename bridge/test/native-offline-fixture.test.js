import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { inspectNativeRollout, nativeSmokeResources, preserveNativeSmokeFailure, readNativeSmokeBudget, runNativeLongResumeSmoke } from "../scripts/native-long-resume-smoke.mjs"
import { lifecycleSignalArgs } from "../scripts/instance-lifecycle-smoke.mjs"
import { offlineProviderConfig, startOfflineResponsesProvider } from "../scripts/fixtures/offline-responses-provider.mjs"

test("large native smoke requires bounded aggregate cgroup limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-smoke-budget-"))
  try {
    for (const [file, value] of Object.entries({ "memory.max": "1073741824", "memory.swap.max": "0", "pids.max": "128", "cpu.max": "100000 100000" })) {
      await writeFile(path.join(root, file), value)
    }
    assert.equal((await readNativeSmokeBudget(root)).enforced, true)
    await writeFile(path.join(root, "memory.max"), "max")
    assert.equal((await readNativeSmokeBudget(root)).enforced, false)
    await writeFile(path.join(root, "memory.max"), "1073741824")
    await writeFile(path.join(root, "memory.swap.max"), "1024")
    assert.equal((await readNativeSmokeBudget(root)).enforced, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("offline provider emits bounded native Responses events and refuses other routes", async () => {
  const provider = await startOfflineResponsesProvider({ items: 2, userMarker: "USER_FIXTURE", assistantMarker: "ASSISTANT_FIXTURE" })
  try {
    const response = await fetch(provider.baseURL + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model", stream: true, input: "USER_FIXTURE" }) })
    const text = await response.text()
    assert.equal(response.status, 200)
    const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    assert.equal(events.filter((event) => event.type === "response.output_item.done").length, 2)
    assert.equal(events.length, 4, "long fixtures need only created, finalized items and completed")
    assert.equal(provider.requests[0].emittedItems, 2)
    assert.equal(provider.requests[0].emittedEvents, 4)
    assert.equal(provider.requests[0].completed, true)
    assert.ok(events.some((event) => event.item?.content?.[0]?.text === "ASSISTANT_FIXTURE"))
    assert.equal((await fetch(provider.baseURL + "/unexpected")).status, 403)
    assert.throws(() => offlineProviderConfig("https://api.openai.com/v1"), /loopback/)
    assert.match(offlineProviderConfig(provider.baseURL), /requires_openai_auth = false/)
  } finally { await provider.close() }
})

test("offline delta comparison preserves complete text and records event amplification", async () => {
  const provider = await startOfflineResponsesProvider({ items: 2, userMarker: "u", assistantMarker: "a", messageStream: "deltas" })
  try {
    const response = await fetch(provider.baseURL + "/responses", { method: "POST", body: JSON.stringify({ model: "fixture-model", stream: true, input: "u" }) })
    await response.text()
    assert.equal(provider.requests[0].emittedItems, 2)
    assert.equal(provider.requests[0].emittedEvents, 14)
    assert.equal(provider.requests[0].completed, true)
  } finally { await provider.close() }
})

test("failure artifacts retain bounded synthetic rollout ranges without the fixture home", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "native-failure-test-"))
  try {
    const home = path.join(temp, "original-home")
    await mkdir(path.join(home, "sessions"), { recursive: true })
    await writeFile(path.join(home, "auth.json"), "DO_NOT_COPY")
    const bytes = Buffer.alloc(5 * 1024 ** 2, 0x61)
    bytes.write("TAIL", bytes.length - 4)
    await writeFile(path.join(home, "sessions", "synthetic.jsonl"), bytes)
    const artifacts = await preserveNativeSmokeFailure(temp, { phase: "seed_turn_drain" })
    assert.deepEqual((await readdir(artifacts)).sort(), ["diagnostics.json", "rollout-0-head.jsonl", "rollout-0-tail.jsonl"])
    const summary = JSON.parse(await readFile(path.join(artifacts, "diagnostics.json"), "utf8"))
    assert.equal(summary.phase, "seed_turn_drain")
    assert.equal(summary.files.reduce((sum, file) => sum + file.bytes, 0), 4 * 1024 ** 2)
    assert.equal(summary.files[1].offset, 3 * 1024 ** 2)
    assert.equal((await readFile(path.join(artifacts, "rollout-0-tail.jsonl"))).subarray(-4).toString(), "TAIL")
    assert.equal((await stat(artifacts)).mode & 0o777, 0o700)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("rollout validation streams records and hashes exactly the frozen prefix", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "native-inspect-test-"))
  try {
    const file = path.join(temp, "rollout.jsonl")
    const source = JSON.stringify({ type: "response_item", payload: { text: "EARLY_ASSISTANT" } }) + "\n"
    await writeFile(file, source + JSON.stringify({ type: "event_msg" }) + "\n")
    const prefix = await inspectNativeRollout(file, "EARLY_ASSISTANT", Buffer.byteLength(source))
    assert.equal(prefix.sha256, createHash("sha256").update(source).digest("hex"))
    assert.equal(prefix.records, 1)
    assert.equal(prefix.assistantContext, true)
    assert.equal((await inspectNativeRollout(file, "EARLY_ASSISTANT")).records, 2)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("external artifacts use unique private directories and preserve unrelated parent files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "native-external-artifacts-test-"))
  try {
    const fixture = path.join(temp, "fixture")
    const parent = path.join(temp, "exports")
    await mkdir(path.join(fixture, "original-home", "sessions"), { recursive: true })
    await mkdir(parent)
    await writeFile(path.join(parent, "unrelated.txt"), "KEEP_EXISTING")
    await writeFile(path.join(fixture, "original-home", "auth.json"), "NEVER_COPY")
    await writeFile(path.join(fixture, "original-home", "config.toml"), "NEVER_COPY")
    await writeFile(path.join(fixture, "original-home", "sessions", "synthetic.jsonl"), Buffer.alloc(5 * 1024 ** 2, 0x61))
    const first = await preserveNativeSmokeFailure(fixture, { phase: "seed_turn_drain" }, parent)
    const second = await preserveNativeSmokeFailure(fixture, { phase: "seed_turn_drain" }, parent)
    assert.notEqual(first, second)
    assert.equal(path.dirname(first), parent)
    await rm(fixture, { recursive: true, force: true })
    assert.equal(await readFile(path.join(parent, "unrelated.txt"), "utf8"), "KEEP_EXISTING")
    for (const directory of [first, second]) {
      assert.deepEqual((await readdir(directory)).sort(), ["diagnostics.json", "rollout-0-head.jsonl", "rollout-0-tail.jsonl"])
      const diagnostics = JSON.parse(await readFile(path.join(directory, "diagnostics.json"), "utf8"))
      assert.equal(diagnostics.files.reduce((sum, file) => sum + file.bytes, 0), 4 * 1024 ** 2)
      assert.equal((await stat(directory)).mode & 0o777, 0o700)
    }
    await assert.rejects(runNativeLongResumeSmoke(["--artifacts-dir=relative"]), /absolute existing directory/)
    await assert.rejects(runNativeLongResumeSmoke([`--artifacts-dir=${path.join(parent, "missing")}`]), /absolute existing directory/)
    await assert.rejects(runNativeLongResumeSmoke([`--artifacts-dir=${path.join(parent, "unrelated.txt")}`]), /absolute existing directory/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("resource diagnostics identify owned descendant thread pressure without argv or environment", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "native-resource-test-"))
  try {
    for (const [pid, parent, threads] of [[110, 1, 7], [111, 110, 45], [112, 1, 99]]) {
      await mkdir(path.join(temp, String(pid)))
      await writeFile(path.join(temp, String(pid), "status"), `Name:\tnative-fixture\nPPid:\t${parent}\nThreads:\t${threads}\nVmRSS:\t1234 kB\n`)
      await writeFile(path.join(temp, String(pid), "environ"), "DO_NOT_READ")
    }
    const resources = await nativeSmokeResources([110], temp, temp)
    assert.deepEqual(resources.processes.map(({ pid, threads }) => ({ pid, threads })), [{ pid: 110, threads: 7 }, { pid: 111, threads: 45 }])
    assert.equal(JSON.stringify(resources).includes("DO_NOT_READ"), false)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test("lifecycle signal uses shell builtin and positional validated namespace PID", () => {
  const container = "harness-lifecycle-00000000-0000-4000-8000-000000000000"
  assert.deepEqual(lifecycleSignalArgs(container, 42, "KILL"), ["exec", container, "sh", "-c", 'kill -s "$1" "$2"', "harness-lifecycle-signal", "KILL", "42"])
  assert.equal(lifecycleSignalArgs(container, 42, "USR2").at(-2), "USR2")
  assert.throws(() => lifecycleSignalArgs(container, "42; exit", "KILL"), /Invalid/)
  assert.throws(() => lifecycleSignalArgs(container, 1, "KILL"), /Invalid/)
  assert.throws(() => lifecycleSignalArgs("existing-service", 42, "KILL"), /Invalid/)
})

for (const external of [false, true]) test(`native failure retains ${external ? "external" : "default"} diagnostics, removes private HOME and identifies failing phase`, { skip: process.platform !== "linux" }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "native-failing-executable-"))
  let retained
  try {
    const executable = path.join(temp, "fake-codex")
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$HOME" > "$0.home"\nif [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; else echo "SYNTHETIC_FAILURE" >&2; exit 23; fi\n', { mode: 0o700 })
    await assert.rejects(runNativeLongResumeSmoke(["--development-small", `--codex=${executable}`, "--items=2", ...(external ? [`--artifacts-dir=${temp}`] : [])]), (error) => {
      assert.match(error.message, /phase=seed_initialize/)
      retained = error.message.match(/; artifacts=(.+)$/)?.[1]
      assert.ok(retained && retained !== "unavailable")
      return true
    })
    const diagnostics = JSON.parse(await readFile(path.join(retained, "diagnostics.json"), "utf8"))
    assert.equal(diagnostics.phase, "seed_initialize")
    assert.match(diagnostics.native[0].stderrTail, /SYNTHETIC_FAILURE/)
    if (external) {
      assert.equal(path.dirname(retained), temp)
      const fixtureHome = await readFile(executable + ".home", "utf8")
      await assert.rejects(stat(path.dirname(fixtureHome)), { code: "ENOENT" })
    } else assert.deepEqual(await readdir(path.dirname(retained)), ["failure-artifacts"])
  } finally {
    await rm(temp, { recursive: true, force: true })
    if (retained && !external) await rm(path.dirname(retained), { recursive: true, force: true })
  }
})
