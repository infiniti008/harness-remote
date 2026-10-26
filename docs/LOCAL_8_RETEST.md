# local.8 retest: Codex core profile and Stop/NEXT

**Candidate:** `3.5.0-local.8`.

**Exact source identity:** immediately before building/running tests, record the full commit SHA from a clean checkout here. Do not substitute a moving branch name or a different `HEAD`:

```
Commit tested: <record full clean HEAD SHA>
Working tree: clean
Image/release digest: <record exact built artifact identity>
```

The release tag/version is not a substitute for the source SHA or built image digest. Keep test evidence tied to those exact identities.

## Scope and expected profile

This candidate disables Codex native `plugins`, `apps`, and `tool_suggest` in Codex 0.163.0 using both CLI configuration and thread configuration. The core profile intentionally preserves explicit MCP servers, shell tools, skills, and provider/model configuration. Verify these boundaries in the native request/config evidence: the three disabled features must remain absent/disabled after startup, thread start/resume, while the explicitly preserved capabilities continue to work.

The related [Codex issue #55479](https://github.com/openai/codex/issues/55479) is a similar report only; it is not evidence of this incident's root cause or of this fix. Do not label the root cause resolved from that reference or from offline tests.

The candidate adds an authenticated, read-only endpoint:

```
GET /v1/agents/codex/session/{sessionId}/execution
```

It returns metadata for the requested Session only; the observer retains at most 64 threads and
12 events per thread. It must not return prompt text, provider output/text, credentials, or other
conversation content. Verify auth, response bounds, no mutation, and redaction on ordinary and
failing sessions.

## Required live checks

The packaged launcher requires externally enforced cgroup v2 limits before startup. Check the
actual image's `--check` output: `resourceLimits.enforced=true`, `developmentOverride=false`.
Verify refusal in a separate uncapped, empty fixture without the development opt-out. This is a
read-only guard, not an attempt to set Supervisor or host limits. Do not set the development
override in lab acceptance, production, systemd or HA. Existing development-only native fixtures
set it explicitly when their command uses `--development-small`; those are not resource acceptance.

Run on the same isolated, resource-limited lab and with the same workload/limits used for the prior Stop/NEXT incident. Repeat the original live sequence for all 20 cycles: send prompt, Stop the active turn, then immediately send NEXT. Require 20/20 cycles to complete without a stuck session, late turn output, stale busy state, or NEXT hang. Also run baseline ordinary prompts before and after the cycles to check that the profile does not break normal turns. Record exact prompts/operations, cycle timing, responses, process/thread snapshots, cgroup counters and logs with the candidate identity.

**At the first failure, before pressing Stop or doing cleanup**, collect the authenticated execution endpoint response for the affected session, the smoke diagnostics/status, and cgroup counters/events. Preserve the evidence before any operation that could change thread or process state. Then perform cleanup and record its result separately. Do not retry away the first failure or report a later passing retry as the original result.

Record each gate as `PASS`, `FAIL`, `BLOCKED_ENV`, or `NOT_RUN`, with evidence paths and the tested commit/image identity. Do not infer pass from a process count alone: compare thread metadata, gateway/native process identity and cgroup deltas as separate signals. State whether every cycle exercised a genuinely active provider request; a synthetic or already-idle cancellation does not count as an active Stop cycle.

## Core-profile regressions

Re-run the bounded long native resume and its gateway continuation, offline native MCP read-only proof, and workspace permission checks (allowed write inside the scoped workspace and denied write outside it) under this exact core profile. Verify preserved MCP/shell/skills/provider behavior while native plugins/apps/tool suggestion stay disabled. These are regression checks for the profile and permission boundary; they do not replace the live Stop/NEXT matrix.

A fresh four-hour soak is not required solely because the unchanged history/cache implementation is present. Run it if the profile changes cache behavior, the live evidence exposes a memory/resource regression, or another acceptance gate requires it. Never equate offline resume, offline MCP, or a synthetic provider with live Stop/NEXT behavior.

## Deployment note

The web and HAOS deployment alternatives and their unresolved constraints are tracked in [HA_DEPLOYMENT_PATH.md](HA_DEPLOYMENT_PATH.md). It does not describe a ready or resource-bounded Supervisor app. Do not use this retest as approval to install the native gateway in an SSH app or an uncapped HAOS container.

## Results

Current development-host evidence (2026-10-26):

| Check | Result and boundary |
| --- | --- |
| Final serial bridge suite | 842/842, zero failures/skips, sanitized temporary HOME/CODEX_HOME/environment. Two earlier runs inherited the real CODEX_PATH and failed CLI-absence tests; the final run removes that environment dependency. `/tmp/harness-local8-final-bridge.log`. |
| Web | TypeScript and production build pass. `web/src` is byte-for-byte unchanged from local.7; no new full web/browser pass is claimed. The user-reported local.7 updated image smoke already passed 6/6. |
| Actual native configuration | Native 0.163.0 `config/read` confirms all three core discovery flags false, without login or model calls. |
| Native/ACP/gateway Stop/NEXT | Synthetic-provider development probe 20/20, 19 cancellations reached an active provider request; idle tasks 51 -> 55, peak 55; peak summed RSS 327720 KiB, both shutdowns have zero tracked descendants. `/tmp/harness-local8-native20-kkjqixqg/`. This preceded the startup-only resource guard and had no enforced aggregate cgroup. |
| Guard and staged runtime | Three resource-guard tests cover inherited systemd/container limits and refusal cases. A real uncapped launcher refuses before even invoking a marker Codex binary or opening ports. After adding the guard, the explicitly opted-out development native 2-cycle/gateway/MCP fixture still passes. `/tmp/harness-local8-guard-native-m8v5wjas/`. Actual capped startup is a target-host check. |
| Explicit MCP | Real native -> read-only stdio MCP -> ACP -> authenticated HTTP passes; marker reaches native context and HTTP tool completion. Run again after the startup guard. |
| Command policy | Real native probe permits its workspace write, leaves the outside marker absent and observes Never-policy escalation rejection. Its `kernelSandboxAccepted` remains false; do not turn this into a Mac or universal sandbox certification. `/tmp/harness-local8-native-permission-smoke.mjs.log`. |
| Live ChatGPT Stop/NEXT | NOT_RUN here. The local.7 live failure is not declared fixed by these synthetic checks. |
| HA installation | NOT_RUN; no HA service or working Harness was changed. |

## Mac lab handoff

Use the exact clean source SHA supplied with this candidate and build the matching local.8 pair
using the existing isolated lab procedure in `LOCAL_6_RETEST.md`. Preserve lab volumes, machine ID,
login, unique HARNESS_LAB_* variables, CORS and the already-owned 15431/15432 mappings; retain
local.7 image IDs and Compose for rollback. Recreate only lab gateway/web. Verify manifests,
authenticated health local.8, runtime/native index and the new enforced-resource preflight.
Do not modify working 4097/5300 services, Home Assistant, auth/session storage, or kernel limits.

Then run the targeted live sequence above and the core-profile regressions, serially. At the
first NEXT failure, retain execution metadata, pending RPCs and cgroup events before cleanup.
Report whether native output began, whether the native turn completed, and whether the delay
occurred before either event. Test a physical phone for normal Send/Stop, keyboard/rotation and
image preview. Remote HTTP/OAuth MCP and multi-machine are optional integrations and do not
block a scoped web + single Codex + selected HA-access milestone if unused.

No additional four-hour cache soak, broad refactor, model/runtime upgrade, automatic retry of a
possibly executed prompt, or migration is part of this targeted acceptance. Record the first
result honestly; a later pass cannot overwrite a failure. If live 20/20 and the selected host's
resource/command/persistence checks pass, prepare the working switch and rollback separately.
