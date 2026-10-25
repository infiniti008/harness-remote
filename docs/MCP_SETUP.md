# Configure MCP for the native Codex agent

Harness Remote in this fork has no MCP manager UI. MCP servers are configured for the native agent
process through that machine's Codex `config.toml`. The OpenAI docs server is a public, read-only
Streamable HTTP server for OpenAI developer documentation; it searches and returns documentation and
does not call the OpenAI API for you. [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp)

## Configure the agent's Codex home

Codex CLI stores MCP configuration in `~/.codex/config.toml` by default. The CLI can add an HTTP
server, list configured servers, and start OAuth login for servers that require it.
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

For a Codex agent running in the Linux lab, configure the Codex home used **inside the gateway
container**. In this lab it is `/data/.codex`; verify the target container and path before changing
anything. Do not run the command from the Mac shell unless the agent itself runs on that Mac. The
Mac's `~/.codex` belongs to the Mac's Codex CLI/IDE and is shared only with processes that use that
same home. ChatGPT MCP connectors are separate and do not automatically appear in Harness Remote.

Check the binary and current list first:

```sh
docker exec <lab-gateway-container> sh -lc '
  export CODEX_HOME=/data/.codex
  test -x /opt/codex/node_modules/.bin/codex
  /opt/codex/node_modules/.bin/codex mcp list
'
```

The path above is the lab's pinned Codex CLI location; verify it exists before use. If the CLI is on
`PATH`, `codex` can be used instead. Add the public documentation server and inspect the result:

```sh
docker exec <lab-gateway-container> sh -lc '
  export CODEX_HOME=/data/.codex
  /opt/codex/node_modules/.bin/codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp
  /opt/codex/node_modules/.bin/codex mcp list
'
```

If a different server requires OAuth, run `codex mcp login <server-name>` in the same runtime and
with the same `CODEX_HOME`. The OpenAI docs server example above is public and does not require
OAuth. Keep tokens and other credentials out of shell history, shared logs, and this repository.

## What this fork passes to Codex

The pinned `codex-acp` 1.13.1 adapter's `createSessionConfig` path receives `mcpServers: []` from
Harness session creation and produces a session configuration with the workspace roots without
clearing MCP entries already in the native Codex configuration. local.6 also verifies this end to
end: real Codex 0.163.0, hardened adapter 1.13.1 and an actual isolated gateway inherited a temporary
stdio MCP configuration, advertised its namespaced tool, invoked the real read-only server, and
returned its unique marker as a completed HTTP tool part. The offline model fixture received the
actual native tool output; it did not invent the result. No real model, account, external MCP or
user configuration was used. This proves that local stdio path, not every HTTP/OAuth server or
approval-requiring tool. A server appearing in `codex mcp list` confirms configuration alone.
The current Harness UI does not expose a separate MCP connection readiness panel or manager.

The lab's hardened native requests use approval policy `never`, a `user` approval reviewer, and
workspace-write sandboxing with network access disabled. The current host cannot provide the needed
user namespace/bwrap sandbox, so shell and file tools are not accepted there. Adding MCP does not fix
that kernel limitation. For a remote HTTP MCP server, its actions are governed by that server's own
authorization and permission checks; do not assume the local native sandbox protects remote actions.
The public OpenAI docs MCP is read-only. For other servers, inspect their tools and permissions
before connecting them.

An MCP server configured in Codex's native home is distinct from ChatGPT connectors, Harness
features, skills, and `AGENTS.md` instructions. Native skills or project instructions may be read by
Codex where available, but that does not mirror every ChatGPT feature into the Harness UI.

## Apply and verify in the lab

The Codex agent process must start with the intended `CODEX_HOME`. Use an empty new test session to
check discovery and a harmless read-only tool call. If the active process does not reload its config,
wait for its queue to become idle and restart only the isolated lab gateway, preserving its volumes
and test login. Do not change the working machine or Home Assistant. Configuration listing alone is
not an MCP end-to-end pass; record whether the native agent actually lists and invokes the expected
tool.

To repeat the isolated stdio proof without changing your configured servers, use the pinned native
binary and the already reviewed candidate adapter/archive:

```sh
node --v8-pool-size=1 --max-old-space-size=128 bridge/scripts/native-mcp-smoke.mjs --codex=/absolute/path/to/pinned/codex
```

It creates and removes its own private HOME and gateway. It performs a read-only marker call and
requires no API key or paid model call. For a container with a temporary `/tmp`, supply
`--artifacts-dir=/artifacts` backed by a fresh private host log directory to retain any failure.

For a stdio MCP server, its executable and pinned dependencies must be installed in the same host or
container that launches Codex, and the `command`, `args`, and environment must be configured there.
An HTTP server is reached by URL instead. This guide intentionally avoids an `npx`/latest stdio
example: adding a server does not authorize installing an unpinned package.
