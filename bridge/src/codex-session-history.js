import { RevisionPageCache } from "./revision-page-cache.js"
import { createHash } from "node:crypto"
import { forwardLines } from "./forward-line-scan.js"
import { HistoryReadBudget, HistoryReadError, HistoryReadGate } from "./history-read-budget.js"
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { scanLinesBackward } from "./backward-line-scan.js"
import { stripAmbientContext } from "./ambient-context.js"

const MODEL_CONTEXT_LOOKBACK_BYTES = 4 * 1024 * 1024

function trimCarriageReturn(buffer) {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.subarray(0, -1) : buffer
}

function recordFromLine(line) {
  try {
    return JSON.parse(trimCarriageReturn(line).toString("utf8"))
  } catch {
    return undefined
  }
}

function textFromCompletedItem(item) {
  if (item?.type === "Reasoning") {
    return Array.isArray(item.summary_text)
      ? item.summary_text.filter((text) => typeof text === "string" && text).join("\n\n")
      : ""
  }
  if (item?.type !== "UserMessage" && item?.type !== "AgentMessage") return ""
  return Array.isArray(item.content)
    ? item.content
      .filter((part) => typeof part?.text === "string" && part.text)
      .map((part) => part.text)
      .join("\n\n")
    : ""
}

function messageFromRecord(sessionID, record, offset) {
  if (record?.type !== "event_msg") return undefined
  const payload = record.payload
  const completedItem = payload?.type === "item_completed" ? payload.item : undefined
  const role = payload?.type === "user_message" || completedItem?.type === "UserMessage" ? "user"
    : payload?.type === "agent_message" || payload?.type === "agent_reasoning"
      || completedItem?.type === "AgentMessage" || completedItem?.type === "Reasoning" ? "assistant"
      : undefined
  if (!role) return undefined

  const type = payload.type === "agent_reasoning" || completedItem?.type === "Reasoning" ? "reasoning" : "text"
  const raw = completedItem ? textFromCompletedItem(completedItem)
    : payload.type === "agent_reasoning" ? payload.text
      : payload.message
  const text = role === "user" ? stripAmbientContext(raw) : raw
  if (typeof text !== "string" || !text) return undefined

  // Rollouts are append-only. A byte offset is therefore both unique inside the file and stable as
  // later turns are appended. The paged tail reader can derive it without first scanning all older
  // lines, unlike the old ordinal-based id.
  const messageID = `${sessionID}:byte:${offset}`
  const created = Date.parse(record.timestamp ?? "")
  return {
    info: {
      id: messageID,
      role,
      sessionID,
      time: { created: Number.isFinite(created) ? created : Date.now() }
    },
    parts: [{ id: `${messageID}:${type}:0`, messageID, type, text }]
  }
}

function messageFromLine(sessionID, line, offset) {
  return messageFromRecord(sessionID, recordFromLine(line), offset)
}

/**
 * Codex persists the model and reasoning effort that own a turn in `turn_context`. Reading that
 * record is lock-free, unlike ACP session/load, and is the same native rollout authority used for
 * transcript recovery. The app presents Codex's bare model ids under the synthetic `codex` provider,
 * matching the ACP catalog's fallback provider id.
 */
function modelFromTurnContext(record) {
  if (record?.type !== "turn_context") return undefined
  const modelID = typeof record.payload?.model === "string" ? record.payload.model.trim() : ""
  if (!modelID) return undefined
  const effortValue = record.payload?.effort ?? record.payload?.collaboration_mode?.reasoning_effort
  const variant = typeof effortValue === "string" && effortValue.trim() ? effortValue.trim() : undefined
  return { providerID: "codex", modelID, ...(variant ? { variant } : {}) }
}

async function readCodexPage(file, sessionID, { limit = 100, before } = {}, limits) {
  const budget = new HistoryReadBudget(limits)
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const handle = await open(file, "r")
  try {
    const { size } = await handle.stat()
    let end = size
    if (before !== undefined && before !== null && before !== "") {
      const prefix = `${sessionID}:byte:`
      const parsed = Number(typeof before === "string" && before.startsWith(prefix) ? before.slice(prefix.length) : before)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > size) {
        throw new HistoryReadError("Invalid Codex history cursor", "INVALID_HISTORY_CURSOR", 400)
      }
      end = parsed
    }

    const found = []
    let currentModel
    const modelSearchFloor = Math.max(0, end - MODEL_CONTEXT_LOOKBACK_BYTES)
    const needMore = (chunkEnd) => found.length <= boundedLimit
      || (!before && !currentModel && chunkEnd > modelSearchFloor)

    for await (const { line, offset, chunkEnd } of scanLinesBackward(handle, { from: end, budget })) {
      if (!needMore(chunkEnd)) break
      const record = recordFromLine(line)
      // Only the newest-page read describes the Session's current model. Older page requests
      // deliberately omit model metadata so paging cannot rewind the picker to a historical turn.
      if (!before && !currentModel) currentModel = modelFromTurnContext(record)
      if (found.length <= boundedLimit) {
        const message = messageFromRecord(sessionID, record, offset)
        if (message) {
          budget.message(message)
          found.push({ message, offset })
        }
      }
      if (found.length > boundedLimit && (before || currentModel)) break
    }

    const hasMore = found.length > boundedLimit
    const newest = found.slice(0, boundedLimit)
    const messages = newest.map((entry) => entry.message).reverse()
    const nextBefore = hasMore && newest.length > 0 ? String(newest[newest.length - 1].offset) : null
    return {
      messages,
      before: nextBefore,
      hasMore,
      ...(currentModel ? { model: currentModel } : {})
    }
  } finally {
    await handle.close()
  }
}

/**
 * Codex allows a single writer per thread and takes the lock for the whole time a client holds the
 * thread open, so `session/load` answers "thread <id> already has an active writer" for every
 * session the Codex desktop app or a `codex` CLI is sitting on, which is precisely the sessions a
 * user wants to look at from their phone. Reading the rollout the harness already wrote takes no
 * lock, so those sessions can be shown even while Codex itself owns them.
 *
 * The transcript comes from the `event_msg` records rather than the `response_item` ones: only the
 * former carry what the user actually saw. Current Codex versions wrap visible turns in
 * `item_completed` (`UserMessage`, `AgentMessage`, and `Reasoning`), while older rollouts use the
 * direct `user_message`, `agent_message`, and `agent_reasoning` event types. The `response_item`
 * records also hold instruction blocks Codex feeds the model, AGENTS.md, the plugin list and desktop
 * app context under the `user` role, which would surface as the user's own turns.
 */
export function createCodexHistoryLoader(sessionRoot = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions"), { pageLimits, fullLimits, gateOptions, cacheOptions } = {}) {
  const sessionFiles = new Map()
  const gate = new HistoryReadGate(gateOptions)

  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined
    try {
      // Rollouts are filed under sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl.
      const suffix = `-${sessionID}.jsonl`
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      const entry = entries.find((candidate) => candidate.isFile() && candidate.name.endsWith(suffix))
      if (!entry) return undefined
      const file = path.join(entry.parentPath ?? entry.path, entry.name)
      sessionFiles.set(sessionID, file)
      return file
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }

  const loadCodexHistory = async function loadCodexHistory(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const budget = new HistoryReadBudget({ maxReadBytes: 64 * 1024 * 1024, maxTextBytes: 8 * 1024 * 1024, ...fullLimits })
    const info = await stat(file)
    if (info.size > budget.maxReadBytes) throw new HistoryReadError("Full history exceeds the safe read size; open it with paging")
    const messages = []
    for await (const { line, offset } of forwardLines(file, { budget })) {
      const message = messageFromLine(sessionID, line, offset)
      if (message) {
        budget.message(message)
        messages.push(message)
      }
    }
    return messages
  }

  loadCodexHistory.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    // Absence is not proof of an empty Session: a rollout may live outside this installation's
    // local tree while ACP session/load can still replay it. Let AcpService distinguish that from a
    // located, genuinely empty rollout and fall through to the protocol source.
    if (!file) return undefined
    return readCodexPage(file, sessionID, options, pageLimits)
  }

  const fullReads = new Map()
  const pageCache = new RevisionPageCache(cacheOptions)
  const share = (pending, key, start) => {
    const active = pending.get(key)
    if (active) return active
    const work = Promise.resolve().then(start)
    pending.set(key, work)
    void work.finally(() => { if (pending.get(key) === work) pending.delete(key) }).catch(() => {})
    return work
  }
  const sharedLoader = (sessionID) => share(fullReads, sessionID, () => gate.run(() => loadCodexHistory(sessionID)))
  Object.assign(sharedLoader, loadCodexHistory)
  const revisionOf = async (file) => {
    const info = await stat(file, { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")
  }
  sharedLoader.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    if (!file) return undefined
    const revision = await revisionOf(file)
    const query = [Math.max(1, Math.min(500, Number(options.limit) || 100)), options.before ?? null]
    return pageCache.read({ scope: file, revision, query,
      load: () => gate.run(() => readCodexPage(file, sessionID, options, pageLimits)),
      current: async () => { try { return await revisionOf(file) === revision } catch { return false } }
    })
  }
  sharedLoader.pageRevision = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    if (!file) return undefined
    const revision = await revisionOf(file)
    return createHash("sha256").update(JSON.stringify([sessionID, revision,
      Math.max(1, Math.min(500, Number(options.limit) || 100)), options.before ?? null])).digest("hex")
  }
  // This window is display state only. Native resume retains Codex's full model context.
  sharedLoader.seed = (sessionID) => sharedLoader.page(sessionID, { limit: 200 })
  sharedLoader.ownsCursor = (sessionID, cursor) => typeof cursor === "string" && (cursor.startsWith(`${sessionID}:byte:`) || /^\d+$/.test(cursor))
  // A located journal is authoritative for paging. Errors must not cause full ACP replay.
  sharedLoader.strictPageErrors = true
  sharedLoader.diagnostics = () => ({ cachedSessionPaths: sessionFiles.size, pageCache: pageCache.diagnostics(), coldReads: gate.diagnostics() })
  return sharedLoader
}
