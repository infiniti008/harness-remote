import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { inspectCodexIndex } from "../src/codex-index-preflight.js"

test("index preflight never creates a missing database or repairs an unfinished lease", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-index-preflight-"))
  const file = path.join(home, "state_5.sqlite")
  try {
    assert.equal((await inspectCodexIndex(home)).status, "missing")
    assert.equal(existsSync(file), false)
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE backfill_state (id INTEGER, status TEXT, updated_at INTEGER); INSERT INTO backfill_state VALUES (1, 'running', 1)")
    db.close()
    const before = await readFile(file)
    assert.equal((await inspectCodexIndex(home)).ready, false)
    assert.deepEqual(await readFile(file), before)
    const completed = new DatabaseSync(file)
    completed.exec("UPDATE backfill_state SET status = 'complete'")
    completed.close()
    assert.equal((await inspectCodexIndex(home)).ready, true)
    assert.equal((await inspectCodexIndex(path.join(home, "other-home"), { sqliteHome: home })).ready, true)
    assert.equal((await inspectCodexIndex(home, { sqliteHome: "relative/path" })).status, "unknown")
    await writeFile(path.join(home, "config.toml"), 'sqlite_home = "/somewhere-else"\n')
    assert.equal((await inspectCodexIndex(home)).status, "unknown")
    assert.equal((await inspectCodexIndex(home, { stateDatabase: file })).ready, true)
    await writeFile(file, "not a SQLite database")
    assert.equal((await inspectCodexIndex(home, { stateDatabase: file })).status, "unreadable")
  } finally { await rm(home, { recursive: true, force: true }) }
})
