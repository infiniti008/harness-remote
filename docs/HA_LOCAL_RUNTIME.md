# Selected target: native Codex inside Home Assistant

The user's required experience is the local Codex workflow of the VS Code app running on HA,
with Harness web as the client. The browser can run on a phone, Mac or HA sidebar; commands,
file reads/writes and local MCP processes execute on the HA machine. They do not use SSH to
perform each agent operation. Mac lab testing remains a staging step, not the deployment target.

## Runtime and files

Prepare a dedicated HA app containing the web entry point, gateway, pinned native Codex and
local tools. Its project mount exposes the actual HA configuration directly, preserving `/config`
as the working path where possible. The Supervisor mapping is `homeassistant_config` with an
explicit `path: /config` and write access; the modern default `/config` mapping named `app_config`
is a different folder and must not be mistaken for the HA configuration.

Keep native state under private persistent `/data/codex`, gateway state under `/data/gateway-state`,
and release binaries outside the writable project. Login, sessions, SQLite state and explicit MCP
configuration survive app restart/update. Do not automatically copy or mount private state from
the SSH or VS Code app. Reusing an existing profile needs a deliberate verified export/restore
with its original paths and a retained backup; an empty destination must not overwrite it.

An app is its own Linux environment. Directly mounting the same HA files does not inherit VS Code's
installed programs, environment variables or extensions. Inventory the commands actually needed
for the user's HA workflow and supply them locally (shell, Git, Python, Node, ripgrep and, where
needed, HA CLI). Verify each selected command and MCP on that target. HA API operations remain
local API operations; they do not require an SSH hop. Do not claim every VS Code extension-specific
capability is provided by the CLI. Avoid competing writers if the same native Session is also
open in another client.

## Web entry and lifetime

Use a single local app entry for web assets and gateway streaming, with HA ingress support for
the prefixed path, SSE and attachments. The current standalone web build/protocol needs an actual
ingress integration check; simply setting `ingress: true` does not implement it. Keep external
LAN ports off by default for the HA app. Preserve the existing standalone Mac test origins/ports.

Own gateway, adapter, native Codex and local MCP descendants in the app's private PID namespace.
Stopping the app or an unexpected gateway/native failure must leave no owned descendants.
Persist data separately from binaries; retain a previous image and test rollback without deleting
data. Do not put the new runtime into the existing SSH/VS Code app during preparation or use the
development unbounded override to get a successful launch.

## Host resource provisioning

The native service must have a verified whole-instance budget before starting: the current
candidate checks <=1 GiB RAM, no additional swap, <=1 CPU and <=128 PIDs read-only. Supervisor's
documented app schema has no corresponding quota fields. Implement installation-time host-side
provisioning for the **specific new app container**, separate from agent operations. The app and
its agent do not need a Docker socket, host PID namespace or a resource-management tool.

Docker supports targeted updates of memory, CPU and PID limits. That is a candidate provisioning
mechanism, not yet a verified Supervisor integration. Rehearse whether the limits persist through
Supervisor start/restart and image/config recreation. A recreated uncapped container must refuse
native startup; provisioning then has to be reapplied before it can run. Do not promise automatic
quota persistence before this is tested, alter other apps' limits or disable the startup guard.

An administrative SSH connection may be used to install/inspect the app or apply its host limits.
That setup connection is not in the model-request or local command path. If ordinary agent work
still requires it, the selected experience has not been implemented.

## Delivery sequence

1. Complete local.8's targeted live Stop/NEXT test in the isolated lab. A native-plugin mitigation
   and synthetic PASS do not establish the cause or repair of the earlier live failure.
2. Stage the HA app package, matching web/gateway, explicit project mount, persistent state and
   local tool inventory. Keep the working HA/VS Code profiles and services intact.
3. Rehearse the exact app under hard limits: startup/refusal, onboarding, direct file access,
   allowed workspace command, blocked outside write, explicit MCP, Stop/NEXT and full teardown.
4. Test ingress on browser/phone, restart/update state retention, resource provisioning after
   recreation and rollback. Only then perform the working HA installation.

The app package and target-host tests are outstanding. This design records the selected
architecture; it is not an assertion that an HA app has been built, published or installed.

References: [HA configuration and folder mappings](https://contributors.home-assistant.io/apps/reference/configuration/),
[HA ingress](https://contributors.home-assistant.io/apps/guides/ingress/),
[targeted Docker resource updates](https://docs.docker.com/reference/cli/docker/container/update/).
