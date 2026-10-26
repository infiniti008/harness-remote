# Deployment path: web first, Home Assistant access

## Current position

**User decision, 2026-10-26:** native Codex must run in the Home Assistant environment, with
direct project-file and local tool access, comparable to the VS Code app on HA. A Mac/NAS gateway
that invokes SSH for ordinary agent operations does not meet the requirement. Use the
[HA-local runtime design](HA_LOCAL_RUNTIME.md) as the target architecture.

The current `distribution/Dockerfile` and `compose.yaml` are Linux/NAS templates, not a released
HA app. The Compose template requests 1 CPU, 1 GiB memory, no swap, 128 PIDs and `restart: no`;
those keys do not become Supervisor settings automatically. The distribution workflow does not
publish an HA image yet. Resource provisioning and target-host sandbox validation are installation
work to complete for the chosen HA-local route, not a reason to substitute remote execution.

The local.8 packaged launcher now refuses startup unless those external cgroup v2 bounds are
visible. This is a read-only startup guard; it does not add missing Supervisor settings or apply
limits to an SSH app. Accept a deployment only with `resourceLimits.enforced=true` and
`developmentOverride=false` in `--check`. The explicit development opt-out is for disposable
synthetic fixtures on an uncapped development host, not an HA deployment route.

## Routes

| Route | Fit | Limits and boundary | Status |
| --- | --- | --- | --- |
| Standalone Linux Docker | Packaging/rehearsal reference | Existing Compose template expresses whole-instance limits and lifecycle. | Useful for controlled packaging tests; does not by itself install an app on HAOS. |
| HAOS Supervisor app | **Selected target: web + native Codex on HA** | Direct HA configuration mapping, private persistent agent state, local commands/MCP. Supervisor schema has no documented cgroup memory/CPU/PID quota keys; host-side provisioning and startup/recreation verification are required. | Implementation target; not yet an installed or validated app. |
| Gateway on Mac/NAS + SSH/MCP access to HA | Does not meet the selected local-execution experience | Executes the agent outside HA. | Not the planned production architecture. Mac remains the isolated test/build host. |

## Why not move the native service into the SSH app

The existing SSH app is not an aggregate resource manager for this workload. Returning the gateway and native Codex process there would put them back in an environment without verified memory, CPU and PID caps or an isolated lifecycle boundary. A project or agent turn can consume resources beyond Node's heap flags, and process-group cleanup alone cannot guarantee removal of descendants that detach. Do not use the SSH app as a shortcut around the Docker/systemd limits or expose its private `/root/.codex` to another app.

## Data and rollback rules

- Keep gateway state and native Codex home separate. On Docker, use dedicated persistent volumes at explicit paths; do not mix release files with mutable state. On a future HA app, `/data` is its private persistent storage and `app_config` is that app's user-facing configuration area; neither is the Home Assistant `/config` folder. Do not map all of Home Assistant config, SSH app data or host root merely to reuse an existing profile.
- Decide where projects live before enabling writes. Prefer one explicitly selected project root. A `share` mapping is broad access to the shared folder, not a per-project mount; constrain the gateway root and verify path traversal and symlink behavior.
- Keep versioned release/image references and the previous known-good configuration. Before upgrades, take a restorable copy of mutable state and record the exact image/release and config. Rollback means stop the candidate and select the prior version while retaining data for inspection; do not uninstall with data removal, clear volumes, or run migrations that cannot be reversed.
- Define credential onboarding separately for each host. The current launcher expects an existing, compatible Codex installation and initialized `CODEX_HOME`; it does not import credentials or state from the SSH app. Never copy private credentials or session history into a published image, shared project directory, or general Home Assistant config mount.

## Decisions needed before selecting a route

The execution-location decision is settled. Before installation, inspect the target HA host and
implement the resource setup, direct project mapping, local tool inventory, separate persistent
Codex state, onboarding/restore and backup/rollback described in the selected design. Do not ask
the user to choose a remote SSH architecture again. Keep existing VS Code, its Codex profile,
historical backups and working Harness intact during preparation.

## Primary references

- [Current Docker template](../distribution/compose.yaml) and [distribution notes](../distribution/README.md).
- [Home Assistant app configuration schema](https://developers.home-assistant.io/docs/apps/configuration/) — accepted config keys, ingress, maps, timeout, host PID and ulimits.
- [Home Assistant app security](https://developers.home-assistant.io/docs/apps/security/) — Protection mode, AppArmor and least privilege.
- [Home Assistant ingress requirements](https://developers.home-assistant.io/docs/apps/presentation/) — authenticated ingress, `172.30.32.2`, `X-Ingress-Path`, streaming and WebSockets.
- [Publishing Home Assistant apps](https://developers.home-assistant.io/docs/add-ons/publishing/) — repository and prebuilt image route.
- [Home Assistant OS file access](https://www.home-assistant.io/common-tasks/os/) — standard OS storage areas.
