import http from "node:http"
import { once } from "node:events"

/** Only serves local synthetic Responses streams; no HTTP client or credentials exist here. */
export async function startOfflineResponsesProvider({ items, userMarker, assistantMarker, continuationMarker = assistantMarker, toolCommands = [], onRequest = () => {}, beforeComplete = async () => {}, messageStream = "completed", continuationMessageStream = messageStream }) {
  if (!Number.isInteger(items) || items < 1 || items > 40000) throw new Error("Invalid bounded offline item count")
  if (!["completed", "deltas"].includes(messageStream)) throw new Error("Invalid offline message stream")
  if (!["completed", "deltas"].includes(continuationMessageStream)) throw new Error("Invalid offline continuation stream")
  const requests = []
  const server = http.createServer(async (request, response) => {
    try {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
        || request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(403); response.end("Offline fixture accepts only loopback POST /v1/responses"); return
      }
      let length = 0
      const chunks = []
      for await (const chunk of request) {
        length += chunk.length
        if (length > 16 * 1024 * 1024) throw new Error("Offline request exceeds 16 MiB")
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString("utf8")
      const body = JSON.parse(raw)
      if (body.model !== "fixture-model" || body.stream !== true) throw new Error("Unexpected offline model request")
      const sequence = requests.length + 1
      const toolOutputs = (Array.isArray(body.input) ? body.input : []).filter((item) => item.type === "function_call_output")
        .map((item) => JSON.stringify(item.output).slice(0, 4096))
      const summary = { sequence, bytes: length, userMarker: raw.includes(userMarker), assistantMarker: raw.includes(assistantMarker), toolOutputs, emittedItems: 0, emittedEvents: 0, emittedBytes: 0, backpressureWaits: 0, elapsedMs: 0, completed: false }
      const started = Date.now()
      requests.push(summary)
      onRequest(summary)
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      const emit = async (event) => {
        const encoded = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        summary.emittedEvents++
        summary.emittedBytes += Buffer.byteLength(encoded)
        summary.elapsedMs = Date.now() - started
        if (!response.write(encoded)) {
          summary.backpressureWaits++
          await new Promise((resolve, reject) => {
            const cleanup = () => { response.off("drain", drained); response.off("close", closed) }
            const drained = () => { cleanup(); resolve() }
            const closed = () => { cleanup(); reject(new Error("Offline response closed during backpressure")) }
            response.once("drain", drained); response.once("close", closed)
          })
        }
      }
      const responseID = `resp_offline_${sequence}`
      await emit({ type: "response.created", response: { id: responseID, object: "response", created_at: 1, status: "in_progress", output: [] } })
      const command = toolCommands[sequence - 1]
      if (command) {
        const tools = body.tools.flatMap((tool) => tool.type === "namespace" ? (tool.tools || []).map((item) => ({ ...item, namespace: tool.name })) : [tool])
        const qualified = (tool) => tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name
        if (command.mcpTool) summary.advertisedTools = tools.map(qualified).filter(Boolean).slice(0, 64)
        const tool = tools.find((item) => command.mcpTool ? qualified(item) === command.mcpTool : ["exec_command", "shell_command"].includes(item.name))
        if (!tool) throw new Error("Offline probe requires its actually advertised tool")
        summary.requestedTool = qualified(tool)
        const args = command.mcpTool ? {} : { [tool.name === "exec_command" ? "cmd" : "command"]: command.command,
          ...(command.escalated ? { sandbox_permissions: "require_escalated", justification: "Offline negative permission probe" } : {}) }
        const item = { type: "function_call", id: `fc_offline_${sequence}`, call_id: `call_offline_${sequence}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args) }
        await emit({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } })
        await emit({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments })
        await emit({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments })
        await emit({ type: "response.output_item.done", output_index: 0, item })
      }
      const count = command ? 0 : toolCommands.length ? 1 : sequence === 1 ? items : 1
      for (let index = 0; index < count; index++) {
        const id = `msg_offline_${sequence}_${index}`
        const text = index === 0 ? sequence === 1 ? assistantMarker : continuationMarker : `m${index}`
        const phase = index === count - 1 ? "final_answer" : "commentary"
        const part = { type: "output_text", text, annotations: [] }
        const item = { id, type: "message", role: "assistant", status: "completed", phase, content: [part] }
        // This fixture tests persisted native context, not token rendering. A finalized item
        // contains the complete text; avoid five redundant streaming events per display row.
        // Keep the delta form selectable for protocol regression comparisons.
        if ((sequence === 1 ? messageStream : continuationMessageStream) === "deltas") {
          await emit({ type: "response.output_item.added", response_id: responseID, output_index: index, item: { ...item, status: "in_progress", content: [] } })
          await emit({ type: "response.content_part.added", item_id: id, output_index: index, content_index: 0, part: { ...part, text: "" } })
          await emit({ type: "response.output_text.delta", item_id: id, output_index: index, content_index: 0, delta: text })
          await emit({ type: "response.output_text.done", item_id: id, output_index: index, content_index: 0, text })
          await emit({ type: "response.content_part.done", item_id: id, output_index: index, content_index: 0, part })
        }
        await emit({ type: "response.output_item.done", output_index: index, item })
        summary.emittedItems++
      }
      await beforeComplete(summary)
      await emit({ type: "response.completed", response: { id: responseID, object: "response", created_at: 1, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: count, total_tokens: count + 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
      summary.completed = true
      summary.elapsedMs = Date.now() - started
      response.end()
    } catch (error) {
      requests.push({ error: error.message })
      if (!response.headersSent) response.writeHead(400)
      response.end()
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  return { baseURL, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

export function offlineProviderConfig(baseURL) {
  const url = new URL(baseURL)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1" || url.username || url.password || url.search || url.hash) {
    throw new Error("Offline provider URL must be a plain loopback HTTP /v1 endpoint")
  }
  return `model = "fixture-model"
model_provider = "offline_fixture"
approval_policy = "never"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
web_search = "disabled"
[features]
plugins = false
remote_plugin = false
apps = false
skill_search = false
skip_host_skill_discovery = true
shell_snapshot = false
[model_providers.offline_fixture]
name = "Offline fixture"
base_url = ${JSON.stringify(baseURL)}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[otel]
exporter = "none"
`
}
