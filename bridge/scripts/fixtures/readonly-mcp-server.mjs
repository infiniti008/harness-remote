// Dependency-free stdio MCP. The sole tool returns its synthetic argv marker, with no I/O.
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"

export function readonlyMcpReply(request, marker) {
  if (!Object.hasOwn(request, "id")) return undefined
  const result = request.method === "initialize"
    ? { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "harness-readonly-fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "read_marker", description: "Return the isolated synthetic marker", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }] }
      : request.method === "tools/call" && request.params?.name === "read_marker" && Object.keys(request.params.arguments || {}).length === 0
        ? { content: [{ type: "text", text: marker }], isError: false }
        : request.method === "ping" ? {} : undefined
  return { jsonrpc: "2.0", id: request.id, ...(result ? { result } : { error: { code: -32601, message: "Only readonly fixture MCP methods are available" } }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!/^MCP_READ_MARKER_[a-zA-Z0-9-]+$/.test(process.argv[2] || "")) throw new Error("Synthetic marker required")
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line.length > 64 * 1024) throw new Error("MCP fixture request exceeds bound")
    const reply = readonlyMcpReply(JSON.parse(line), process.argv[2])
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n")
  }
}
