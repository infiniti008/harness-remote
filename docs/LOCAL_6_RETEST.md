# local.6: isolated Mac lab retest

Candidate branch: `fix/lab-continuity-local6`; release version: `3.5.0-local.6`. Record the exact
immutable commit from a clean checkout before building. This guide
inherits the lab isolation, ports, volumes, private environment, resource limits, and rollback rules
from [LOCAL_5_RETEST.md](LOCAL_5_RETEST.md). Retain the verified local.5 images for rollback. Do not
start anything on Home Assistant or roll back the lab to older runtime images to avoid local.6 gates.

See LOCAL_6_VALIDATION.md for completed local checks; repeat on the clean immutable lab checkout.
Previous local.5
evidence is limited to its own candidate: offline 40,000-item native probe passed with 40,000 items,
80,012 records, 40,001 displayed messages, 112.1 seconds, 509,440,000 bytes peak memory, and 47
peak PIDs; lifecycle smoke passed 5/5. The local.5 soak report is still pending, and its live
gateway 40,000-item case was not checked. Those results do not satisfy local.6 gateway-continuation
acceptance. The bwrap/user-namespace limitation remains, PID use previously peaked at 122/128, and
physical-phone validation remains unverified. Do not raise resource limits.

## Upgrade the lab

Verify the existing Compose project is still `harness-lab-20261023` at
`/Users/nikitenok.sl/harness-lab-20261023`, using Docker labels. Its previous web/gateway mappings
were 15431→8080 and 15432→4902; check ownership with Docker and `lsof` before reusing them. Keep
4097/5300, Webtop 6200/6201, browser 7900/9222, and all other 4901/4902 services untouched.

1. Save the current Compose configuration, image IDs, test login, machine ID, both lab volumes,
   unique `HARNESS_LAB_*` values, and private `.env` contents and permissions for rollback. Never
   print credentials or mount working HOME, `.codex`, `.ssh`, real projects, or a Docker socket.
   Stop only this lab's soak before replacing its gateway and record the final soak status; a pending
   report is not a pass.
2. Build from the clean local.6 checkout and record its exact commit. Use the pinned versions Node
   `24.21.0`, Codex `0.163.0`, and adapter `1.13.1`. Run the approved build/test list serially on the
   memory-limited Docker VM; do not install unpinned `latest` dependencies or edit vendor files.
3. Verify health versioning at both authenticated routes, `/global/health` and `/v1/health`. Their
   `harnessVersion` must match root `package.json`, the web release manifest, and the packaged
   `release.json`. The focused health test checks both routes against package metadata and any
   existing release manifest; release assembly must also pass its staged metadata assertion. An
   unauthenticated health request must remain rejected.
4. Recreate only this lab's web and gateway. Preserve allowed web origins, volumes, login, and
   machine identity. Keep gateway limits at 1 GiB, zero swap, 1 CPU, 128 PIDs, 15-second stop
   deadline, `restart=no`; keep web limits at 128 MiB, 0.25 CPU, and 32 PIDs. Recheck preflight,
   native index, health/auth, versions, cgroups, ports, other services, and volumes. A short startup
   gap is not a health failure: wait for diagnostics and native-index readiness. Do not treat a
   ready container alone as proof of successful continuation.
5. Repeat the critical queue/Stop cases inherited from local.4: queue, edit, remove, and Send now
   prompts during a live reply; race Send now with early and streaming Stop; confirm no queued prompt
   starts after Stop and a failed Stop confirmation remains an error.

## UI geometry stress

Run `web/scripts/local6-workspace-smoke.mjs` against the built real app. It uses synthetic transport
responses in isolated incognito CDP contexts and tests the light desktop, light and dark phone, and
phone-landscape views. By default it runs 3 rounds across 4 viewports (12 cases); set
`HARNESS_UI_ITERATIONS=1..20` to change the repeat count. Use the lab's own CDP endpoint, never the
shared browser on port 9222. Point `HARNESS_UI_ARTIFACTS_DIR` at an absolute writable mount backed by
a fresh private directory under the lab logs so JSON and screenshots survive container teardown.

Require every visible first-frame sample after cached-session open to remain at the tail within
1 px, including every captured frame; inspect the JSON's full frame list and bad-coordinate samples.
The stress case reopens a cached Session with a stored multiline draft, then checks that autosizing
pins its geometry immediately after layout. ResizeObserver updates content and viewport geometry
before paint for initial-tail/live updates only, and must stop moving the reader after interaction.
Also require the phone composer status row to reserve at least 24 px, quota text not to wrap, and the real
synthetic external SSE append to leave a reader at scroll position 0. Any gap, movement, overflow,
or frame outside the 1 px tolerance fails the case.

## Native seed and actual gateway continuation

Run the large case with `bridge/scripts/native-long-resume-smoke.mjs --items=40000
--gateway-continuation`. It uses a private temporary `CODEX_HOME`, a synthetic offline provider, the
pinned native Codex and adapter, and an actual staged local.6 gateway. It waits for native index
backfill without editing the native database, then starts the gateway. It does not create a 40,000-row
fixture in either lab volume. The global watchdog is 180 seconds and the gateway-continuation phase
has a 120-second deadline; do not increase either timeout.

Use the verified local.6 source/image in the existing bounded candidate container with `--network=none`,
read-only root, private `/tmp`, and an isolated writable artifact mount. Publish no ports. Make a
fresh mode-700 host directory under the lab logs and omit `--rm` until status and resource evidence
are collected:

```sh
lab_logs="/Users/nikitenok.sl/harness-lab-20261023/logs"
artifact_dir="$lab_logs/local6-native-$(date +%Y%m%d%H%M%S)"
mkdir -m 700 "$artifact_dir"
container="harness-local6-native-$(date +%Y%m%d%H%M%S)"
docker run --name "$container" --network=none --read-only --tmpfs /tmp:rw,size=256m --memory=1g --memory-swap=1g --cpus=1 --pids-limit=128 --mount type=bind,source="$PWD",target=/work,readonly --mount type=bind,source="$artifact_dir",target=/diagnostics --entrypoint /usr/bin/tini <verified-local6-image> -g -- node --v8-pool-size=1 --max-old-space-size=128 /work/bridge/scripts/native-long-resume-smoke.mjs --codex=/opt/codex/node_modules/.bin/codex --items=40000 --gateway-continuation --artifacts-dir=/diagnostics
```

Confirm the run reports the expected pinned versions and enforced limits. It must demonstrate all of
the following before it passes:

- The native-written rollout and backfilled index discover the exact Session without database edits;
  initial authenticated gateway health matches the candidate version, and unauthenticated HTTP
  returns 401.
- While the gateway-held continuation reply is still busy, HTTP pagination returns the original
  native messages without duplicate IDs. The compatibility read stays bounded at 200 messages and
  the tail remains at most 202 after the live user/assistant messages.
- SSE sends invalidations, followed by an HTTP read that finds the actual new assistant text. The
  continuation provider input includes early user and assistant context, the source rollout snapshot
  hash is unchanged, and every original rollout byte remains an unchanged prefix.
- Resource samples remain inside 1 GiB, zero swap, 1 CPU, and 128 PIDs. Prior local.5 PID peak was
  122, so any pressure is evidence to preserve and investigate, not a reason to raise the limit.

Wait for diagnostics and native-index readiness during startup rather than treating the startup
window as a false failure. On failure, use the printed artifact path under `/diagnostics` on the
host; do not depend on `docker cp` from `/tmp`, which is tmpfs. Keep the stopped container until
version, phases, native record/message counts, memory/PID peaks, and exit status are recorded, then
remove only that exact container. Artifacts are bounded synthetic excerpts and diagnostics; do not
retain HOME or credentials. A missing image, unsupported cgroup budget, skipped case, or timeout is
not a pass.

The current gateway-continuation large acceptance remains open. The local.5 soak report, physical
phone gate, and host bwrap/user-namespace limitation also remain outstanding until separately
resolved. See [MCP_SETUP.md](MCP_SETUP.md) for setup and the separate verified readonly stdio probe;
remote HTTP/OAuth and approval-requiring tools still need their own checks. Do not deploy local.6 to
working Harness or Home Assistant. Rollback
stops only this lab and restores its retained local.5 images/configuration without removing volumes.
