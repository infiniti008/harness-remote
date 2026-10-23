import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"
import { closeOwnedChildProcess, ownChildProcess } from "../src/managed-child-process.js"

test("waits for native child exit and escalates when SIGTERM can be ignored", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"]
  })
  ownChildProcess(child)
  await once(child.stdout, "data")

  const startedAt = Date.now()
  const closing = closeOwnedChildProcess(child, { graceMs: 100 })
  assert.equal(closeOwnedChildProcess(child, { graceMs: 1 }), closing, "concurrent closes must reuse one promise")
  await closing

  // Windows terminates children immediately for SIGTERM; installing a JS handler cannot ignore it.
  // Unix must instead exhaust the grace period and escalate for this child.
  if (process.platform === "win32") {
    assert.equal(child.signalCode, "SIGTERM", "Windows must observe native termination before close resolves")
  } else {
    assert.equal(child.signalCode, "SIGKILL", "the child that ignored SIGTERM must receive SIGKILL")
    assert.ok(Date.now() - startedAt >= 75, "close must wait through the SIGTERM grace period")
  }
})

test("close resolves for a child that already exited", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
  ownChildProcess(child)
  await once(child, "exit")
  await closeOwnedChildProcess(child)
  assert.equal(child.exitCode, 0)
})

test("closing an explicitly owned POSIX group also terminates an uncooperative grandchild", { skip: process.platform === "win32", timeout: 8000 }, async () => {
  const childSource = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
    child.stdout.on('data', data => process.stdout.write(data));
    setInterval(()=>{},1000);
  `
  const child = spawn(process.execPath, ["--v8-pool-size=1", "--max-old-space-size=32", "-e", childSource], {
    detached: true, stdio: ["ignore", "pipe", "ignore"]
  })
  ownChildProcess(child, { processGroup: true })
  let grandchild
  try {
    grandchild = Number((await once(child.stdout, "data"))[0].toString().trim())
    assert.ok(grandchild > 1)
    await closeOwnedChildProcess(child, { graceMs: 100 })
    // A zombie awaits its container's reaper but is no longer consuming CPU/RAM.
    let live = true
    for (let attempt = 0; attempt < 100 && live; attempt++) {
      try {
        if (process.platform === "linux") {
          const { readFile } = await import("node:fs/promises")
          const state = (await readFile(`/proc/${grandchild}/stat`, "utf8")).split(") ")[1]?.split(" ")[0]
          live = state !== "Z"
        } else process.kill(grandchild, 0)
      } catch { live = false }
      if (live) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(live, false, "grandchild must not keep running after wrapper exit")
  } finally {
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
})
