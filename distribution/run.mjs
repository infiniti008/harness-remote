#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { findCodexExecutable } from "../bridge/src/executable-discovery.js"
import { inspectCodexIndex } from "../bridge/src/codex-index-preflight.js"
import { homedir } from "node:os"
import path from "node:path"

const root = new URL("../", import.meta.url)
const metadata = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log(metadata.version)
} else if (args.includes("--help")) {
  console.log(`Harness Remote local candidate ${metadata.version}\nUsage: node distribution/run.mjs [daemon options]\n--check validates installed prerequisites without starting a gateway.\nThis candidate uses Codex 0.163.0 and bundled codex-acp 1.13.1.\nCODEX_HOME is inherited unchanged. Configure a separate --state-dir explicitly.`)
} else {
  const codex = findCodexExecutable()
  const adapter = fileURLToPath(new URL("vendor/codex-acp/dist/index.js", root))
  let codexVersion = "unavailable"
  if (codex) {
    codexVersion = execFileSync(codex, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 16_384 }).trim()
  }
  const nativeIndex = await inspectCodexIndex(process.env.CODEX_HOME || path.join(homedir(), ".codex"), {
    stateDatabase: process.env.HARNESS_CODEX_STATE_DB
  })
  const check = {
    harness: metadata.version, node: process.versions.node, codex: codexVersion,
    nativeIndex,
    bundledAdapter: existsSync(adapter),
    compatible: process.versions.node === "24.21.0" && /\b0\.163\.0\b/.test(codexVersion) && existsSync(adapter) && nativeIndex.ready
  }
  if (args.includes("--check")) {
    console.log(JSON.stringify(check, null, 2))
    if (!check.compatible) process.exitCode = 1
  } else {
    if (!check.compatible) throw new Error(`Candidate preflight failed: ${nativeIndex.reason || "requires Node 24.21.0, Codex 0.163.0 and the bundled adapter"}; run --check`)
    if (args.includes("--acp-command") || args.some((arg) => arg.startsWith("--acp-command="))) {
      throw new Error("This candidate pins its ACP adapter; use the source daemon for custom adapters")
    }
    const backendArg = args.findIndex((arg) => arg === "--backend")
    if (backendArg >= 0 && args[backendArg + 1] !== "codex") throw new Error("This candidate launcher is validated for Codex only")
    if (args.some((arg) => arg.startsWith("--backend=") && arg !== "--backend=codex")) throw new Error("This candidate launcher is validated for Codex only")
    process.env.CODEX_PATH = codex
    process.env.HARNESS_REMOTE_ACP_ARGS = JSON.stringify(["--v8-pool-size=1", "--max-old-space-size=96", adapter])
    const daemon = fileURLToPath(new URL("bridge/src/daemon-cli.js", root))
    process.argv = [process.execPath, daemon, "--backend", "codex", "--no-opencode", "--acp-command", process.execPath, ...args]
    // Run in this process: no npm/shell wrapper sits between the service manager and Harness.
    await import(pathToFileURL(daemon).href)
  }
}
