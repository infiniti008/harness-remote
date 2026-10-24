#!/usr/bin/env node
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { hardenCodexAdapter } from "./codex-adapter-policy.js"

// Transform only the pinned distribution adapter in memory. Keep its original module URL,
// so vendor-relative helpers resolve normally. Neither the archive nor installed caches change.
const adapterPath = process.argv[2]
if (!adapterPath || !process.env.CODEX_PATH) throw new Error("A pinned adapter and native Codex executable are required")
if (process.platform === "win32") throw new Error("The local Codex sandbox candidate requires Linux or macOS")
const adapterURL = pathToFileURL(adapterPath).href
const source = hardenCodexAdapter(readFileSync(adapterPath, "utf8"))
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === adapterURL) return { format: "module", source, shortCircuit: true }
    return nextLoad(url, context)
  }
})
process.argv = [process.execPath, adapterPath, ...process.argv.slice(3)]
try { await import(adapterURL) } finally { hooks.deregister() }
