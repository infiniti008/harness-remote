# local.7: investigate live Stop/NEXT before another release

The user's Mac acceptance report is **failed**: a confirmed Stop was followed by a hanging NEXT,
so the live 20-cycle series could not finish. Build, long history, Queue and offline soak passing
do not override this result. Keep working Harness and Home Assistant unchanged.

The immutable candidate remains `09f56d91215adfd44439a733466e44ca34ec630b` / `3.5.0-local.7`.
Branch `fix/stop-next-investigation` changes diagnostic scripts and regression tests only. Runtime
sources, native policy, resource limits, release archives and version are unchanged. This is not
local.8 and does not claim to fix the live hang.

## Findings and completed checks

- Reviewed the exact checksum-verified codex-acp 1.13.1 cancellation path. `AcpClient.cancelSession`
  waits for the original ACP prompt response; a native `turn/interrupt` acknowledgement alone does
  not release its pending writer guard. Do not replace that guard with a timer or force-clear it.
- Five actual pinned-adapter regressions use a deterministic native transport: completion before
  interrupt acknowledgement, acknowledgement before completion, delayed turn/start response,
  interrupt error followed by completion, and NEXT completion before its turn/start response.
  All five pass; they do **not** reproduce or explain the live Mac hang. Including the existing
  inactivity/cancellation regressions, the focused suite passes 14/14 with no skips.
- The mobile image smoke had fixed 80 ms waits while the detail pane has a 180 ms transition.
  It now waits for bounded stable animation/layout frames and semantic focus states, verifies
  actual viewport dimensions/orientation after rotation, and saves failure JSON/PNG. Acceptance
  geometry remains 1 px. Runtime UI/CSS did not change. All six cases pass on the unchanged local.7
  production app here, using synthetic transport. This is not a reproduction of the Mac failure
  and does not replace a physical-phone check.
- Updated native endurance diagnostic records Stop latency and distinct submit/wait/confirm
  phases. On failure it captures sanitized pending RPC/service/session status and cgroup counters
  **before** releasing the provider or stopping its private gateway. The private two-cycle native
  development check passed (49 -> 49 idle tasks, peak 51, no owned descendants after shutdown).
  An intentional failure in a disposable script copy saved `failure-state.json` with pending=1
  before cleanup, then shut down all three tracked processes. Neither run had enforced aggregate
  Mac cgroup limits; neither used ChatGPT live transport.

Local artifacts:

- `/tmp/harness-local7-stop-ordering-tests.log`
- `/tmp/harness-local7-preview-timing-review3/` (six JSON/PNG pairs)
- `/tmp/local7-stop-diagnostic-probe-sblxtkue/`
- `/tmp/local7-stop-failure-capture-8vfif6za/`

## Next task for the Mac agent

First collect the **existing failure**, without starting another full acceptance run or rebuilding:

1. Read the local.7 Stop/NEXT logs in the existing lab directory. Record the failing cycle, times,
   Stop HTTP status/body, NEXT HTTP status/body/disposition, original observation deadline, and
   whether the NEXT marker appeared in a user row, assistant text, or an error. Distinguish a
   hanging HTTP submission from an accepted prompt waiting for model output.
2. If that Session is still stuck, capture authenticated `/v1/diagnostics` and
   `/v1/agents/codex/session/status` before another Stop or gateway restart. Take two snapshots
   about one second apart. Inspect only the relevant Session's pending methods, ages, idle ages,
   cancellation flags, service active/queued/load counts and native/adapter process health.
   Read credentials from the existing private lab configuration without printing them.
3. Collect the lab container's existing cgroup memory/PID events and current/peak counters,
   Docker OOM/restart state, and bounded process/thread counts. Use host-side Docker inspection
   first; avoid launching many `docker exec` commands inside a possibly exhausted PID budget.
   If exec cannot fork, retain that evidence. Do not raise limits to make diagnostics succeed.
4. Retain relevant gateway/native stderr around the Stop and NEXT. Do not dump process
   environments, auth files, QR/pairing tokens, or entire conversation/provider payloads. Return
   a short redacted timeline plus the relevant counters/pending entries. Do not enable the
   vendor's general APP_SERVER_LOGS globally: it can record prompt contents.

Classify from evidence before changing runtime: NEXT waiting in HTTP/preparation; ACP load/config
pending; ACP prompt submitted but native turn not started; native turn active without output;
native completed but gateway remains busy; or PID/OOM/transport failure. A response without the
expected marker is not by itself proof of a deadlocked cancellation path.

Only after preserving the first failure, repeat the **targeted live Stop/NEXT** test in a dedicated
lab Session under the existing limits/deadlines. Capture the first failure and stop the series.
Keep the failed Session intact until its diagnostics are saved. Do not restart as a passing test,
increase deadlines, ignore PID events, or rerun the four-hour cache soak to substitute for this gate.

The updated `native-endurance-smoke.mjs` remains an **offline synthetic-provider** probe. It can
be copied alone into an extracted local.7 package following `LOCAL_6_ENDURANCE.md`, using the exact
local.7 image and a fresh diagnostic directory. Do not run its nested gateway inside the active
lab gateway. A pass there does not close the real-model Stop/NEXT gate.

For image preview, run the updated `web/scripts/chat-image-preview-smoke.mjs` and its unchanged
`local5-workspace-smoke.mjs` dependency from this diagnostic checkout against the existing local.7
web. Use a private browser/profile/CDP port verified free in both address families, as described in
`LOCAL_7_RETEST.md`. No gateway recreation is needed. Preserve the failure JSON/PNG if it fails.
The test supplies synthetic transport in incognito pages and does not use the lab login or model.

Kernel sandbox on that Mac, physical phone and full live Stop/NEXT acceptance remain open.
No working/HA deployment is approved by these diagnostic results.
