#!/usr/bin/env node
// Offline native MCP inheritance proof. All configuration belongs to a fresh disposable HOME.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runNativeLongResumeSmoke } from "./native-long-resume-smoke.mjs"

export async function runNativeMcpSmoke(argv = process.argv.slice(2)) {
  assert.ok(argv.every((arg) => /^(--codex|--archive|--artifacts-dir)=/.test(arg)), "Only --codex, --archive and --artifacts-dir are accepted")
  return runNativeLongResumeSmoke(["--development-small", "--gateway-continuation", "--items=2", ...argv], {
    mcpProbe: { marker: `MCP_READ_MARKER_${randomUUID()}`, serverScript: fileURLToPath(new URL("./fixtures/readonly-mcp-server.mjs", import.meta.url)) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeMcpSmoke().catch((error) => { console.error(JSON.stringify({ status: "failed", error: error.message })); process.exitCode = 1 })
}
