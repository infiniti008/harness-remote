# Deployment path: web first, Home Assistant access

## Current position

Keep the web client and native Codex gateway on a host with enforceable aggregate limits. Treat Home Assistant as a UI/integration target until a Supervisor app can meet the same resource and lifecycle requirements. The current `distribution/Dockerfile` and `compose.yaml` are Linux/NAS templates, not a released HA app; the Compose template requests 1 CPU, 1 GiB memory, no swap, 128 PIDs, and `restart: "no"`, but it has not been validated as a production image. The distribution workflow does not publish a container image.

The local.8 packaged launcher now refuses startup unless those external cgroup v2 bounds are
visible. This is a read-only startup guard; it does not add missing Supervisor settings or apply
limits to an SSH app. Accept a deployment only with `resourceLimits.enforced=true` and
`developmentOverride=false` in `--check`. The explicit development opt-out is for disposable
synthetic fixtures on an uncapped development host, not an HA deployment route.

## Routes

| Route | Fit | Limits and boundary | Status |
| --- | --- | --- | --- |
| Standalone Linux Docker | Best immediate fit for web + native Codex | Existing Compose template expresses cgroup CPU/memory/swap/PID limits and `restart: no`. Mount only an explicit project root and a dedicated persistent state volume. Preserve absolute Codex/project paths. Do not mount the Docker socket. | Template only; build, host cgroup enforcement, stop/descendant cleanup, persistence, backup and rollback still need target-host verification. |
| HAOS Supervisor app | Best eventual in-HA web entry | Supervisor schema supports app ingress, storage mappings, AppArmor/protection mode and stop timeout. The documented schema has no cgroup memory, CPU quota or PID-limit setting; `ulimits.nproc` does not equal a cgroup PID cap. Do not claim 1 GiB/1 CPU/128-PID enforcement or a production-safe native app without another documented and tested control. | Not ready: no HA app image/repository/CI is published, and a fresh app data directory does not contain a prepared Codex home. |
| Gateway on Mac/NAS + HA-facing integration | Viable if HAOS cannot enforce required limits | Keep the bounded gateway on the Mac/NAS. Connect HA only through a separately scoped, read-only MCP/API integration, or a narrowly limited SSH account/command with an explicit path allowlist. Avoid host-wide credentials, shell access, or broad filesystem mounts. | Candidate architecture only; no assumption that a suitable MCP, SSH account, or integration is already installed. Must test the exact identity, paths, verbs and network exposure. |

## Why not move the native service into the SSH app

The existing SSH app is not an aggregate resource manager for this workload. Returning the gateway and native Codex process there would put them back in an environment without verified memory, CPU and PID caps or an isolated lifecycle boundary. A project or agent turn can consume resources beyond Node's heap flags, and process-group cleanup alone cannot guarantee removal of descendants that detach. Do not use the SSH app as a shortcut around the Docker/systemd limits or expose its private `/root/.codex` to another app.

## Data and rollback rules

- Keep gateway state and native Codex home separate. On Docker, use dedicated persistent volumes at explicit paths; do not mix release files with mutable state. On a future HA app, `/data` is its private persistent storage and `app_config` is that app's user-facing configuration area; neither is the Home Assistant `/config` folder. Do not map all of Home Assistant config, SSH app data or host root merely to reuse an existing profile.
- Decide where projects live before enabling writes. Prefer one explicitly selected project root. A `share` mapping is broad access to the shared folder, not a per-project mount; constrain the gateway root and verify path traversal and symlink behavior.
- Keep versioned release/image references and the previous known-good configuration. Before upgrades, take a restorable copy of mutable state and record the exact image/release and config. Rollback means stop the candidate and select the prior version while retaining data for inspection; do not uninstall with data removal, clear volumes, or run migrations that cannot be reversed.
- Define credential onboarding separately for each host. The current launcher expects an existing, compatible Codex installation and initialized `CODEX_HOME`; it does not import credentials or state from the SSH app. Never copy private credentials or session history into a published image, shared project directory, or general Home Assistant config mount.

## Decisions needed before selecting a route

1. Which host will run the native gateway (Linux Docker host, Mac/NAS, or HAOS only), its architecture, available RAM/swap and whether required cgroups are enabled and enforceable?
2. Is the first milestone only the web UI inside HA, or must native Codex run on the HAOS machine? If HAOS is mandatory, is absence of Supervisor cgroup limits acceptable, or is the route blocked until a tested external resource boundary exists?
3. Which exact project directory should be writable, and which HA data, if any, must be visible? Can HA-facing access be read-only and limited to named entities/files/actions?
4. Which credential onboarding and recovery flow is approved on the selected host, and which existing setup (if any) is in scope? No current SSH/MCP installation is assumed.
5. What is the accepted backup/restore point and rollback check for gateway state, Codex home, projects and the prior image/config?

## Primary references

- [Current Docker template](../distribution/compose.yaml) and [distribution notes](../distribution/README.md).
- [Home Assistant app configuration schema](https://developers.home-assistant.io/docs/apps/configuration/) — accepted config keys, ingress, maps, timeout, host PID and ulimits.
- [Home Assistant app security](https://developers.home-assistant.io/docs/apps/security/) — Protection mode, AppArmor and least privilege.
- [Home Assistant ingress requirements](https://developers.home-assistant.io/docs/apps/presentation/) — authenticated ingress, `172.30.32.2`, `X-Ingress-Path`, streaming and WebSockets.
- [Publishing Home Assistant apps](https://developers.home-assistant.io/docs/add-ons/publishing/) — repository and prebuilt image route.
- [Home Assistant OS file access](https://www.home-assistant.io/common-tasks/os/) — standard OS storage areas.
