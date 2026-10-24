#!/usr/bin/env node
// Opt-in, isolated Docker test. Every mutation is scoped to a fresh random container name.
// Supply an already built candidate image containing Node 24 and /usr/bin/tini; no image is pulled.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const exec = promisify(execFile)
const image = process.argv.find((arg) => arg.startsWith("--image="))?.slice(8)
const docker = async (args, timeout = 15000) => (await exec("docker", args, { timeout, maxBuffer: 256 * 1024 })).stdout.trim()
const skip = (reason) => console.log(JSON.stringify({ status: "skipped", reason }))
if (!image) {
  skip("Supply --image=<already-built-candidate-image>; no build, pull, or existing service is touched")
} else {
  let available = true
  try { await docker(["info", "--format", "{{.OSType}}"]); await docker(["image", "inspect", image]) } catch { available = false }
  if (!available) skip("Docker daemon or requested local image unavailable")
  else {
    const repo = fileURLToPath(new URL("../../", import.meta.url))
    for (const scenario of ["gateway-term", "gateway-kill", "adapter-death", "native-death", "native-oom"]) {
      const name = `harness-lifecycle-${randomUUID()}`
      const startedAt = new Date().toISOString()
      let id
      try {
        id = await docker(["run", "--detach", "--name", name, "--label", "harness.isolated-lifecycle=true", "--restart=no",
          "--memory=128m", "--memory-swap=128m", "--cpus=0.5", "--pids-limit=64", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,size=16m",
          "--mount", `type=bind,source=${repo},target=/work,readonly`, "--entrypoint", "/usr/bin/tini", image,
          "-g", "--", "node", "--v8-pool-size=1", "--max-old-space-size=32", "/work/bridge/scripts/fixtures/instance-lifecycle-fixture.mjs"])
        const info = JSON.parse(await docker(["inspect", name]))[0]
        assert.equal(info.HostConfig.Memory, 128 * 1024 * 1024)
        assert.equal(info.HostConfig.MemorySwap, info.HostConfig.Memory)
        assert.equal(info.HostConfig.RestartPolicy.Name, "no")
        let tree
        for (let attempt = 0; attempt < 100 && !tree; attempt++) {
          const logs = await docker(["logs", name])
          tree = logs.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return {} } }).find((event) => event.ready && event.detached)
          if (!tree) await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.ok(tree?.gateway && tree?.native && tree?.adapter && tree?.detached, "fixture process tree must be ready")
        // Capture host PIDs only from this fresh container; never kill those PIDs directly.
        const hostPids = (await docker(["top", name, "-eo", "pid"])).split("\n").slice(1).map(Number).filter((pid) => pid > 1)
        if (scenario === "gateway-term") await docker(["kill", "--signal=TERM", name])
        else {
          const target = scenario === "gateway-kill" ? tree.gateway : scenario === "adapter-death" ? tree.adapter : tree.native
          try {
            await docker(["exec", name, "kill", scenario === "native-oom" ? "-USR2" : "-KILL", String(target)])
          } catch (error) {
            // The namespace can disappear after kill succeeds but before Docker returns exec's
            // status. Accept that race only after confirming this exact container has stopped.
            const stopped = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name]))
            if (stopped.Running) throw error
          }
        }
        const exit = await docker(["wait", name], 20000)
        const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name]))
        assert.equal(state.Running, false)
        assert.equal(state.Restarting, false)
        assert.equal(exit, scenario === "gateway-term" ? "0" : scenario === "gateway-kill" ? "137" : "1")
        assert.ok(hostPids.length >= 4)
        // PID namespace teardown is confirmed by an empty container process listing, including
        // the native descendant that ignored TERM and called setsid(). No host-wide matching.
        await assert.rejects(docker(["top", name, "-eo", "pid"]))
        let oomEvents = ""
        if (scenario === "native-oom") {
          oomEvents = await docker(["events", "--since", startedAt, "--until", new Date().toISOString(), "--filter", `container=${id}`, "--filter", "event=oom", "--format", "{{json .}}"])
          assert.ok(state.OOMKilled || oomEvents, "must observe kernel cgroup OOM, not only a Node heap error")
        }
        console.log(JSON.stringify({ status: "passed", scenario, container: name, exitCode: state.ExitCode, oomKilled: state.OOMKilled, kernelOomEvent: Boolean(oomEvents), processCountBefore: hostPids.length }))
      } finally {
        // Only the exact randomly named container created above is ever removed.
        if (id) await docker(["rm", "--force", name]).catch(() => {})
      }
    }
  }
}
