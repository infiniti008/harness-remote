# Native permissions and isolated lifecycle checks

The local.3 failure came from native Codex policy, outside ACP permission responses. The exact
codex-acp 1.13.1 bundle defaults to Agent mode with `approvalPolicy: on-request` and
`approvalsReviewer: auto_review`. Its `turn/start` sends those values to native Codex. Native
auto-review can approve a sandbox escalation before any `session/request_permission` reaches the
bridge. Setting only `HARNESS_REMOTE_PERMISSION_MODE=deny` therefore did not enforce the intended
policy. The adapter also offered a full-access preset.

Official OpenAI documentation distinguishes [sandbox limits from approval policy](https://learn.chatgpt.com/docs/agent-approvals-security)
and describes [native thread and turn request overrides](https://learn.chatgpt.com/docs/app-server).
Current documentation is context; the regression below exercises the pinned adapter actually shipped.

## Candidate enforcement

The distribution launcher enters `bridge/src/codex-adapter-entry.js`. That wrapper checks the
original vendor bundle SHA256 and uses Node 24 module load hooks to apply a reviewed transform in
memory. Vendor archives, npm caches, active processes and agent homes are untouched. A different
bundle fails startup until its native path is reviewed. The wrapper retains the vendor module URL
and runs in the same ACP process; it does not add a shell or another native process.

The transform enforces `never` approval, `user` reviewer and `workspace-write` at native process
startup and every `thread/start`, `thread/resume`, `thread/fork`, and `turn/start`. Network and extra
writable roots are disabled; the workspace policy excludes environment tmpdir and `/tmp` writes.
Only Workspace mode is offered. Full-access/auto-review modes cannot be selected through ACP
mode or config-option requests. Unsolicited native command/file approvals are declined and native
permission grants return an empty permission set. Read-only native history remains native: resume
still uses the original thread id and `excludeTurns`; no display history is sent as model context.
Model selection, effort and original rollout data remain intact.

`_account/rate_limits` reads `account/rateLimits/read` over the same native connection. It starts
no session or model call and returns native account limits without changing permissions.

A failed user namespace remains a tool failure. Installing bubblewrap does not prove namespace
support. On the actual isolated host, repeat an allowed workspace write, an outside-workspace
write, and the denied-namespace escalation case. Confirm outside writes never appear and native
output reports refusal; do not add privileged mode, bypass flags, approval or larger budgets to
obtain a passing run. This code/transport regression does not prove host kernel sandbox isolation.

## Shutdown boundary

Owned POSIX process groups are killed when their adapter exits or is intentionally closed.
The candidate additionally stops the gateway with exit status 1 on an unexpected adapter exit;
expected close, pool eviction, Stop escalation and provider replacement retain their close paths.
Unexpected native app-server death ends its adapter, which triggers that gateway failure.
The candidate has no automatic restart loop. Source launches retain their previous recovery
behavior unless `HARNESS_REMOTE_EXIT_ON_ADAPTER_FAILURE=1` is explicitly set.

A process that calls `setsid()` escapes an ancestor's process group. Gateway SIGKILL cannot run a
JavaScript exit hook. Reliable whole-instance cleanup therefore requires a service boundary:

- The Docker entrypoint runs the gateway directly under `tini -g`. When the gateway exits,
  tini exits and the container runtime tears down its PID namespace, including detached children.
  The Compose template retains 1 GiB aggregate memory/no swap, one CPU, 128 PIDs, a 15-second stop
  deadline, and `restart: no`. No Docker socket, host PID namespace or privileged mode is needed.
- `distribution/harness-remote.service` is an uninstalled systemd example using
  `KillMode=control-group`, `SendSIGKILL=yes`, `OOMPolicy=kill`, and the same aggregate resource bounds.
  Supply reviewed paths, credentials and a dedicated user before installing it in an isolated lab.
  systemd handles arbitrary unit OOM victims as a whole-unit failure.

Docker may kill an arbitrary process inside its memory cgroup without stopping the gateway. The
native-branch OOM smoke below verifies our native-death failure chain. Universal whole-cgroup OOM
termination additionally requires host cgroup-v2 `memory.oom.group=1` or equivalent supervisor
policy; this Compose template does not claim to set it. A bare Node launch cannot guarantee
detached-descendant cleanup on gateway SIGKILL. Keep the candidate behind an enforced boundary.

## Offline checks

Run the pinned real adapter against the deterministic native transport (no credentials or model
requests). Provide the already verified archive when it is not present in `.vendor-cache`:

```sh
HARNESS_CODEX_ACP_ARCHIVE=/path/to/codex-acp-1.13.1.tgz node --test --test-concurrency=1 bridge/test/codex-adapter-policy.test.js bridge/test/managed-child-process.test.js
```

This checks actual ACP initialization/new/resume/load/fork/prompt/config paths through the vendored
adapter, including native request fields, a malicious inherited config, disabled full access,
unsolicited approval denial, preserved native resume identity, account limits connection reuse,
and fixture-native SIGKILL. Managed-child tests cover intentional/unexpected adapter exit,
SIGTERM escalation and descendants in an owned process group.

On a Docker host, use an already built candidate image with Node 24 and tini:

```sh
node bridge/scripts/instance-lifecycle-smoke.mjs --image=harness-remote-local:<candidate>
```

The smoke creates fresh random containers with no network, credentials, agent-home mounts or
gateway ports. The source mount is read-only. Each fixture has a gateway, adapter, native child
and a descendant that calls `setsid()` and ignores SIGTERM. Cases cover gateway TERM, gateway
SIGKILL, adapter death, native death and a native process's kernel OOM. The OOM fixture first verifies
a 128 MiB/no-swap cgroup and retains external buffers until the kernel intervenes; it does not raise
the production budget. It requires a kernel OOM event, not a Node heap error. Exit/teardown is
verified and cleanup only removes the exact new random container. Nothing finds or kills existing
services by process name. Missing Docker/image reports `skipped`, never `passed`.

The local execution environment has no usable Docker daemon/tini, so whole-instance namespace and
OOM acceptance remain external lab gates. Keep the full smoke JSON output, tested image digest,
native versions and actual-host sandbox outcomes with the candidate validation report.

## Actual native offline tool probe

On Linux with `tar` and `prlimit` (util-linux), an existing verified native executable and pinned
adapter archive, run the following. Supply the actual native binary, not an npm JavaScript shim.
On Mac, execute this probe inside the isolated Linux lab image:

```sh
node --v8-pool-size=1 --max-old-space-size=96 bridge/scripts/native-permission-smoke.mjs --codex=/absolute/path/to/native/codex --archive=/path/to/codex-acp-1.13.1.tgz
```

This uses a fresh temporary home, the hardened real adapter and real native Codex0.163.0. A
loopback-only Responses fixture asks for a workspace write, an ordinary outside write, and an
explicit require_escalated outside write. It requires the forbidden file to remain absent and
observes the actual native Never-policy rejection. Native address space is capped at1GiB, CPU
time at10seconds, adapter heap at96MiB, and the probe has a30second watchdog. It does not supply
real model credentials or read a real conversation. RLIMIT_NPROC is deliberately not used for
this small probe because it counts every thread of the shared UID, not this process tree. Use
the externally bounded lab for whole-subtree resource acceptance.

Local result: passed_native_escalation_denied; workspaceWriteSucceeded=true; outsideFileCreated=false;
nativeNeverRejectionObserved=true; four offline requests. Kernel/namespace acceptance on the
actual Docker host and the original bwrap-failure reproduction remain required separately.
