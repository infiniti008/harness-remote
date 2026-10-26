// Metadata only. This observer never controls turns, retries requests, stores text or reads files.
// It is serialized into the exact pinned adapter so it observes that adapter's existing connection.
export function createCodexNativeObservation() {
  const sessions = new Map()
  const phases = new Set(["completed", "interrupted", "failed", "inProgress"])
  const observeMethods = new Set(["turn/started", "turn/completed", "thread/status/changed", "item/started", "item/completed", "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "error"])
  const outputMethods = new Set(["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta"])
  const get = (threadID) => {
    if (typeof threadID !== "string" || threadID.length > 256) return
    let state = sessions.get(threadID)
    if (!state) {
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value)
      state = { threadID, events: [], generation: 0 }
      sessions.set(threadID, state)
    }
    return state
  }
  const record = (state, method, kind) => {
    const at = Date.now()
    state.lastActivityAt = at
    state.events.push({ at, method, kind })
    if (state.events.length > 12) state.events.shift()
  }
  return {
    requestStarted(request) {
      if (!["turn/start", "turn/interrupt", "turn/steer"].includes(request.method)) return
      const state = get(request.params?.threadId)
      if (!state) return
      if (request.method === "turn/start") {
        state.generation++
        state.submittedAt = Date.now()
        delete state.turnID
        delete state.startedAt
        delete state.firstOutputAt
        delete state.completedAt
        state.turnStatus = "starting"
      }
      record(state, request.method, "request")
      return { state, generation: state.generation }
    },
    requestFinished(request, token, result, failed) {
      if (!token || sessions.get(token.state.threadID) !== token.state || token.state.generation !== token.generation) return
      const state = token.state
      record(state, request.method, failed ? "error" : "response")
      if (request.method === "turn/start" && !failed && result?.turn) {
        state.turnID = String(result.turn.id).slice(0, 256)
        // Completion can arrive before the turn/start reply. Never turn it back into inProgress.
        if (!state.completedAt) state.turnStatus = phases.has(result.turn.status) ? result.turn.status : "unknown"
      }
    },
    notification(event) {
      if (!observeMethods.has(event.method)) return
      const params = event.params
      const state = get(params?.threadId)
      if (!state) return
      const turnID = params.turnId ?? params.turn?.id
      // Keep late events from a known old turn out of the new turn's output timestamps.
      if (state.turnID && turnID && turnID !== state.turnID) return
      record(state, event.method, "notification")
      if (event.method === "thread/status/changed") {
        const status = params.status?.type
        if (["notLoaded", "idle", "active", "systemError"].includes(status)) state.threadStatus = status
      }
      if (event.method === "turn/started") {
        state.turnID = String(params.turn?.id ?? params.turnId).slice(0, 256)
        state.startedAt = Date.now()
        state.turnStatus = "inProgress"
      }
      if (outputMethods.has(event.method)) state.firstOutputAt ??= Date.now()
      if (event.method === "turn/completed") {
        state.completedAt = Date.now()
        state.turnStatus = phases.has(params.turn?.status) ? params.turn.status : "unknown"
      }
    },
    read() {
      const now = Date.now()
      return { profile: "core", disabledDiscoveryFeatures: ["plugins", "apps", "tool_suggest"], observedAt: now,
        sessions: [...sessions.values()].map(({ generation: _generation, ...state }) => ({ ...state,
          ...(state.submittedAt ? { elapsedMs: Math.max(0, now - state.submittedAt) } : {}),
          ...(state.lastActivityAt ? { idleMs: Math.max(0, now - state.lastActivityAt) } : {}),
          events: state.events.map((event) => ({ ...event })) })) }
    }
  }
}
