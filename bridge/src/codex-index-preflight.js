import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/** Inspect only. Never changes a lease, runs backfill, or creates/rebuilds a database. */
export async function inspectCodexIndex(home, { stateDatabase } = {}) {
  const config = path.join(home, "config.toml")
  if (!stateDatabase && existsSync(config)) {
    const text = readFileSync(config, "utf8")
    if (/^\s*(?:sqlite_home\s*=|\[sqlite(?:\.|\]))/m.test(text)) {
      return { status: "unknown", ready: false, reason: "Custom SQLite location requires HARNESS_CODEX_STATE_DB for the preflight" }
    }
  }
  const file = stateDatabase || path.join(home, "state_5.sqlite")
  if (!existsSync(file)) return { status: "missing", ready: false, reason: "Native history index must be initialized under resource limits before starting the gateway" }
  let database
  try {
    const { DatabaseSync } = await import("node:sqlite")
    database = new DatabaseSync(file, { readOnly: true })
    const state = database.prepare("SELECT status, updated_at FROM backfill_state WHERE id = 1").get()
    const status = typeof state?.status === "string" ? state.status : "unknown"
    return { status, ready: status === "complete", updatedAt: state?.updated_at ?? null,
      ...(status === "complete" ? {} : { reason: "Native history indexing is unfinished; automatic startup/retry is paused" }) }
  } catch {
    return { status: "unreadable", ready: false, reason: "Could not safely inspect the native history index; no repair was attempted" }
  } finally { database?.close() }
}
