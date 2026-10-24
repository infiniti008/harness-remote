import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readNativeSmokeBudget } from "../scripts/native-long-resume-smoke.mjs"
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
    assert.ok(events.some((event) => event.item?.content?.[0]?.text === "ASSISTANT_FIXTURE"))
    assert.equal((await fetch(provider.baseURL + "/unexpected")).status, 403)
    assert.throws(() => offlineProviderConfig("https://api.openai.com/v1"), /loopback/)
    assert.match(offlineProviderConfig(provider.baseURL), /requires_openai_auth = false/)
  } finally { await provider.close() }
})
