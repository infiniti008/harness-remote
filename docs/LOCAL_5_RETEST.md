# local.5: isolated Mac lab retest

Candidate branch: `fix/lab-polish-local5`; expected release version: `3.5.0-local.5`.
Start from a clean checkout and record its exact commit before building. Do not build from a moving
branch or a dirty working tree. local.5 inherits all local.4 features and acceptance requirements in
[LOCAL_4_RETEST.md](LOCAL_4_RETEST.md); this guide adds the local.5 checks and updates the native
probe procedure. Passing the lab-patched-copy Mac report (5/5) is prior evidence only: rerun the
current scripts against this exact checkout before marking local.5 passed.

## Upgrade only the existing lab

First verify the existing Compose project is still `harness-lab-20261023` at
`/Users/nikitenok.sl/harness-lab-20261023`, using Docker labels. Its prior web/gateway mappings were
15431→8080 and 15432→4902; confirm ownership with Docker and `lsof` before reuse. Keep 4097/5300,
Webtop 6200/6201, browser 7900/9222, and all other 4901/4902 services untouched. Do not start
anything on Home Assistant.

1. Save current Compose configuration and image identities for rollback. Preserve both lab volumes,
   machine ID, test login, test projects, unique `HARNESS_LAB_*` values, and private `.env` contents
   and permissions. Never print credentials or mount working HOME, `.codex`, `.ssh`, real projects,
   or a Docker socket. Stop only this lab's soak before replacing its gateway; record its final status
   first, and do not count a running soak as passed.
2. Build and test from the clean local.5 checkout, recording the exact commit and release manifest.
   Keep builds serial on the memory-limited Docker VM. Use the already pinned native/tool versions:
   Codex `0.163.0`, adapter `1.13.1`, Node `24.21.0`. Do not fetch runtime `npm latest` packages or
   edit installed vendor files.
3. Build gateway and web from that same release. Retain the verified local.4 images. Recreate only
   this lab's gateway/web, preserving the existing allowed web origins and lab identity. Keep the
   enforced limits unchanged: gateway 1 GiB, zero extra swap, 1 CPU, 128 PIDs, 15-second stop
   deadline, `restart=no`; web 128 MiB, 0.25 CPU, 32 PIDs. Do not raise memory, PID, or deadlines.
4. Recheck preflight/native index, test login, health/auth, versions, cgroups, old services and both
   volumes. Rollback stops only this lab and restores its retained images/configuration without
   removing volumes.

## local.5 UI and native checks

- Run `web/scripts/local5-workspace-smoke.mjs` against the real built app with a transport mock in
  isolated incognito CDP contexts. Set `HARNESS_UI_CDP_URL` and `HARNESS_UI_APP_URL` for the local
  browser and app. It covers light/dark desktop and phone-sized viewports. Require the first visible
  frame after opening an inactive cached session to start at the tail, then confirm slow background
  revalidation leaves a reader at the top. Check the composer focus cascade, attachment pill at or
  below 32 px with a 24 px remove control, aligned menu labels, and menu bounds. Expected pill height
  is 28 px after the later cascade fix. Capture and retain the six screenshots and JSON output.
- Repeat all five cases in `bridge/scripts/instance-lifecycle-smoke.mjs` against the verified local.5
  image. The built-in process-group kill fix needs a fresh run; earlier results do not cover this
  checkout. Missing Docker/image is skipped, not passed.
- Rerun `bridge/scripts/native-long-resume-smoke.mjs` in a fresh isolated container. Default
  `--message-stream=completed` emits one finalized event per message; optionally compare with
  `--message-stream=deltas`. Both must create the same native items and satisfy the inherited
  rollout immutability, paging, native-resume context, and continuation requirements. The enhanced
  probe reports phase/progress every five seconds and bounded failure artifacts. Use only the pinned
  Codex `0.163.0`, no credentials, real mounts, or published ports.
- The large 40,000-item acceptance remains open until a current-checkout run passes under enforced
  1 GiB memory, zero swap, 1 CPU, and at most 128 PIDs. First confirm 1.5–2 GiB free memory beyond
  existing Docker VM workloads; otherwise defer without stopping other services. Do not raise any
  limits. Create a fresh private artifact directory under the lab logs, a uniquely named container,
  and omit `--rm`. `/tmp` is a tmpfs here, so do not rely on `docker cp` from it after exit.

  ```sh
  lab_logs="/Users/nikitenok.sl/harness-lab-20261023/logs"
  artifact_dir="$lab_logs/local5-native-$(date +%Y%m%d%H%M%S)"
  mkdir -m 700 "$artifact_dir"
  # Run from the clean checkout root; use the verified candidate image below.
  container="harness-local5-native-$(date +%Y%m%d%H%M%S)"
  docker run --name "$container" --network=none --read-only --tmpfs /tmp:rw,size=256m --memory=1g --memory-swap=1g --cpus=1 --pids-limit=128 --mount type=bind,source="$PWD",target=/work,readonly --mount type=bind,source="$artifact_dir",target=/diagnostics --entrypoint /usr/bin/tini <verified-local5-image> -g -- node --v8-pool-size=1 --max-old-space-size=128 /work/bridge/scripts/native-long-resume-smoke.mjs --codex=/opt/codex/node_modules/.bin/codex --items=40000 --artifacts-dir=/diagnostics
  ```

  On failure, the smoke writes a private, unique bounded artifact subdirectory directly into
  `$artifact_dir`; keep it on the host and inspect its diagnostics. It contains at most 8 MiB of
  synthetic rollout excerpts plus diagnostics and must not include HOME. Keep the stopped container
  until version, phases, record/message counts, memory/PID peaks, and exit status are recorded; then
  remove only that exact container with `docker rm "$container"`. A failed or unsupported run is not
  a pass.
- Keep the remaining gates visible: host user namespaces are unavailable and sandbox policy denies
  escalation; do not approve a bypass or grant privileged mode. PID-limit pressure is unresolved,
  and the physical-phone checks remain untested. Do not raise limits to make any case pass.

Do not deploy local.5 to working Harness or Home Assistant. Mark it ready only after current-checkout
build, release verification, all inherited local.4 gates, the five lifecycle cases, UI smoke, and
large native acceptance pass; leave phone and host-policy limitations explicit until separately
resolved.
