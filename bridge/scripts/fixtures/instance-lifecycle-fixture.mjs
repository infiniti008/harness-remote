// Offline process-tree fixture for the opt-in Docker smoke. No gateway port or agent home.
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { writeFileSync } from "node:fs"
import { ownChildProcess, closeOwnedChildProcess } from "../../src/managed-child-process.js"

const role = process.argv[2] || "gateway"
const args = ["--v8-pool-size=1", "--max-old-space-size=32", process.argv[1]]
if (role === "detached") {
  process.on("SIGTERM", () => {})
  process.stdout.write(JSON.stringify({ detached: process.pid }) + "\n")
  setInterval(() => {}, 1000)
} else if (role === "native") {
  const detached = spawn(process.execPath, [...args, "detached"], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  const line = (await once(detached.stdout, "data"))[0].toString().trim()
  process.stdout.write(JSON.stringify({ ...JSON.parse(line), native: process.pid }) + "\n")
  process.on("SIGTERM", () => {})
  process.on("SIGUSR2", () => {
    // This process is inside the smoke container's already verified 128 MiB/no-swap cgroup.
    // Prefer it as the OOM victim, then exercise native -> adapter -> gateway fatal shutdown.
    try { writeFileSync("/proc/self/oom_score_adj", "1000") } catch {}
    process.stdout.write(JSON.stringify({ oomAllocationStarted: true }) + "\n")
    const retained = []
    const allocate = () => { retained.push(Buffer.alloc(8 * 1024 * 1024, 0x5a)); setImmediate(allocate) }
    allocate()
  })
  setInterval(() => {}, 1000)
} else if (role === "adapter") {
  const native = spawn(process.execPath, [...args, "native"], { stdio: ["ignore", "pipe", "ignore"] })
  createInterface({ input: native.stdout }).on("line", (line) => {
    const data = JSON.parse(line)
    process.stdout.write(JSON.stringify({ ...data, adapter: process.pid }) + "\n")
  })
  native.once("exit", () => process.exit(1))
  setInterval(() => {}, 1000)
} else {
  process.env.HARNESS_REMOTE_EXIT_ON_ADAPTER_FAILURE = "1"
  const adapter = ownChildProcess(spawn(process.execPath, [...args, "adapter"], { detached: true, stdio: ["ignore", "pipe", "inherit"] }), { processGroup: true })
  createInterface({ input: adapter.stdout }).on("line", (line) => {
    process.stdout.write(JSON.stringify({ ...JSON.parse(line), gateway: process.pid, ready: true }) + "\n")
  })
  process.on("SIGTERM", async () => { await closeOwnedChildProcess(adapter, { graceMs: 100 }); process.exit(0) })
  setInterval(() => {}, 1000)
}
