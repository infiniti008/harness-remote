import assert from "node:assert/strict"
import test from "node:test"
import { inspectRuntimeResourceLimits } from "../src/runtime-resource-limits.js"

function fixture({ own = "/", root = "/", files = {} } = {}) {
  return { platform: "linux", read: async (file) => {
    if (file === "/proc/self/cgroup") return `0::${own}\n`
    if (file === "/proc/self/mountinfo") return `1 2 0:30 ${root} /cg ro - cgroup2 cgroup rw\n`
    if (!(file in files)) throw new Error("not visible")
    return files[file]
  } }
}
const capped = { "/cg/memory.max": "1073741824", "/cg/memory.swap.max": "0", "/cg/cpu.max": "100000 100000", "/cg/pids.max": "128" }

test("resource guard recognizes container namespace and inherited systemd limits", async () => {
  for (const options of [fixture({ files: capped }), fixture({ root: "/host/container", files: capped }), fixture({ own: "/system.slice/harness.service", files: capped })]) {
    assert.deepEqual(await inspectRuntimeResourceLimits(options), { memory: 1073741824, swap: 0, cpu: 1, pids: 128, enforced: true })
  }
})

test("resource guard refuses unbounded, swapped, excessive and unreadable budgets", async () => {
  for (const files of [{}, { ...capped, "/cg/memory.max": "max" }, { ...capped, "/cg/memory.swap.max": "1" }, { ...capped, "/cg/cpu.max": "200000 100000" }, { ...capped, "/cg/pids.max": "129" }]) {
    assert.equal((await inspectRuntimeResourceLimits(fixture({ files }))).enforced, false)
  }
  assert.equal((await inspectRuntimeResourceLimits({ platform: "darwin" })).enforced, false)
  assert.equal((await inspectRuntimeResourceLimits({ read: async () => { throw new Error("denied") } })).enforced, false)
})

test("resource guard uses the most restrictive visible ancestor and rejects an unmapped hierarchy", async () => {
  const options = fixture({ own: "/child", files: { ...capped, "/cg/child/memory.max": "2147483648", "/cg/child/memory.swap.max": "max", "/cg/child/cpu.max": "max 100000", "/cg/child/pids.max": "max" } })
  assert.equal((await inspectRuntimeResourceLimits(options)).enforced, true)
  assert.equal((await inspectRuntimeResourceLimits(fixture({ own: "/other", root: "/parent", files: capped }))).enforced, false)
})
