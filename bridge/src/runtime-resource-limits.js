import { readFile } from "node:fs/promises"
import path from "node:path"

// Read-only startup guard, not a resource manager. Limits must already be enforced externally.
export async function inspectRuntimeResourceLimits({ platform = process.platform, read = (file) => readFile(file, "utf8") } = {}) {
  const limits = { memory: null, swap: null, cpu: null, pids: null }
  const result = (reason) => ({ ...limits, enforced: !reason, ...(reason ? { reason } : {}) })
  if (platform !== "linux") return result("requires Linux cgroup v2 resource controls")
  try {
    const [membership, mounts] = await Promise.all([read("/proc/self/cgroup"), read("/proc/self/mountinfo")])
    const own = membership.split("\n").find((line) => line.startsWith("0::"))?.slice(3)
    const mount = mounts.split("\n").find((line) => line.includes(" - cgroup2 "))?.split(" - ")[0].split(" ")
    if (!own || !mount) return result("cgroup v2 membership or mount is unavailable")
    const decode = (value) => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    const root = decode(mount[3]), point = decode(mount[4])
    // A container cgroup namespace reports '/' even when the host hierarchy has a longer root.
    const relative = own === "/" ? "" : path.posix.relative(root, own)
    if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return result("cgroup membership is outside its visible mount")
    let directory = path.posix.join(point, relative)
    const minimum = (key, value) => {
      if (Number.isFinite(value) && value >= 0) limits[key] = limits[key] === null ? value : Math.min(limits[key], value)
    }
    for (let depth = 0; depth < 64; depth++) {
      const [memory, swap, cpu, pids] = await Promise.all(["memory.max", "memory.swap.max", "cpu.max", "pids.max"].map((name) => read(path.posix.join(directory, name)).catch(() => "max")))
      for (const [key, raw] of [["memory", memory], ["swap", swap], ["pids", pids]]) if (/^\d+$/.test(raw.trim())) minimum(key, Number(raw.trim()))
      const [quota, period] = cpu.trim().split(/\s+/)
      if (/^\d+$/.test(quota) && Number(period) > 0) minimum("cpu", Number(quota) / Number(period))
      if (directory === point) break
      directory = path.posix.dirname(directory)
    }
    const enforced = limits.memory > 0 && limits.memory <= 1024 ** 3 && limits.swap === 0
      && limits.cpu > 0 && limits.cpu <= 1 && limits.pids > 0 && limits.pids <= 128
    return result(enforced ? null : "requires <=1GiB RAM, zero swap, <=1 CPU and <=128 PIDs for the whole instance")
  } catch { return result("cannot inspect the instance cgroup limits") }
}
