# local.4: isolated lab upgrade and acceptance

Use branch `fix/lab-hardening-local4` from `infiniti008/harness-remote`. Record its exact commit;
do not merge a moving upstream branch into the tested checkout. This candidate includes local.1
memory/history bounds, local.2 native-resume and Stop changes, and local.3 compact layout.

## Upgrade only the existing lab

The known Mac lab is Compose project `harness-lab-20261023`, in
`/Users/nikitenok.sl/harness-lab-20261023`. Verify this is still correct from container labels first.
Its web/gateway mappings were 15431→8080 and 15432→4902. Check ownership with Docker and lsof;
reuse only those mappings if they still belong to this lab. Never take a port owned by another app.
Keep the working 4097/5300, Webtop 6200/6201, browser 7900/9222, and other 4901/4902 untouched.
Do not start anything on Home Assistant.

1. Save current lab Compose/image identities for rollback. Preserve both lab volumes, machine ID,
   test login, test projects, unique `HARNESS_LAB_*` variables and the private `.env` permissions.
   Never print credentials or mount working HOME/.codex/.ssh, real projects or a Docker socket.
   If a lab soak is still running, record its final status before replacing its gateway; a running
   soak is not a passed soak. Stop only that lab's soak before upgrading it.
2. Use a clean separate checkout at the chosen commit. Install root/web lockfiles with
   `npm ci --ignore-scripts` and `npm --prefix web ci --ignore-scripts` in bounded build containers.
   Run bridge tests serially with an empty temporary HOME/CODEX_HOME and unset CODEX_PATH;
   run `npm --prefix web run test:ci:full` and `npm --prefix web run build`. Limit V8 worker count
   and heap; do not build gateway/web concurrently on a memory-starved Docker VM.
3. Run `python3 distribution/build-release.py` from the clean checkout. Verify `SHA256SUMS` and
   matching `release.json`: version 3.5.0-local.4, expected commit, dirty=false. Build gateway from
   `distribution/Dockerfile` with `RELEASE_VERSION=3.5.0-local.4`; use web from the same release.
   Retain the verified old images. No runtime npm latest downloads or edits to installed vendor files.
4. Recreate only the lab gateway/web. Keep enforced aggregate limits: gateway 1 GiB, no extra swap,
   1 CPU, 128 PIDs, 15-second stop deadline, restart=no; web 128 MiB/0.25 CPU/32 PIDs. Preserve
   exact allowed web origins; obtain the current LAN address rather than assuming an old address.
   Recheck preflight/native index, test login, health/auth, versions, cgroups, old services and volumes.

## Functional cases

- During an active Codex reply, send A/B/C. They must appear in order in the queued strip while
  the original task continues. Edit B in place, preserving its images and place; remove C. Press
  Send now on B: it must supplement the current turn once, not call Stop. Repeat/double-click,
  switch away/back, and perform the action near turn completion. An unsupported/slash prompt
  stays queued with a clear error. Lost steering acknowledgement must never cause automatic replay.
  Queue state is server-owned for this gateway lifetime; it is not a durable native task queue.
- Repeat early Stop and streaming Stop from LOCAL_2_RETEST.md, including Send now racing with Stop.
  Check no old prompt starts after Stop and no stale output appears. A failed confirmation remains
  an error, not a false successful stop. Background metadata RPCs are distinct from a live prompt.
- Open inactive cached sessions at their tail immediately, with no animated journey from the top.
  Check initial open, repeated switching, images, loading older pages and deliberate upward scrolling.
  Later background refreshes must not steal the reader's position.
- Focus the composer: only its outer border highlights. Check model/select/button alignment at
  desktop, narrow desktop, portrait and landscape widths. Open an image above assistant text and
  sticky controls; panel/background must be opaque, Escape closes and focus returns to its opener.
- Limits show the selected Codex machine's native account data, remaining percentages and reset
  times. Missing windows/unsupported accounts say unavailable; no guessed zeros. Check 5-hour and
  weekly values, multiple limit buckets, reconnection, switching machines, hidden tab polling and
  the mobile popover bounds. No extra native process/session/model request should be created.
- Use the physical phone for image selection/paste where supported, keyboard resize, rotation,
  menu bounds and Send/Stop/queue actions. Desktop emulation does not replace this gate.

## Native tools and whole-instance shutdown

Follow LOCAL_4_NATIVE_SAFETY.md, including its actual native offline permission probe. Native `never`/`user` and workspace-write must appear on actual
start/resume/fork/turn requests. No Full access mode or auto-review fallback may re-enable escalation.
Repeat the old bwrap-failure reproduction: require_escalated must not create the test file. If
namespaces remain unavailable, tools remain blocked; do not approve a bypass or grant privileged mode.

Run the opt-in offline lifecycle smoke with an already-built lab image:

```sh
node bridge/scripts/instance-lifecycle-smoke.mjs --image=<verified-local4-image>
```

It creates only fresh random containers with no ports or real data mounts. Require every scenario
to pass, including a detached descendant that ignores TERM. Save output and image digest. Missing
Docker/image is skipped, not passed. Arbitrary-child OOM whole-group handling additionally requires
host cgroup `memory.oom.group=1` or an equivalent supervisor policy; the Compose template does not
claim to set that. Do not modify the HA host's cgroups.

## Correct long native resume

The old 40,000 appended `event_msg` lines without native ordinal are display/cache fixtures only.
Do not rewrite them, invent ordinals, or raise read limits to make them resume.

`bridge/scripts/native-long-resume-smoke.mjs` creates a new empty temporary home and uses a
loopback-only synthetic Responses provider. Pinned native Codex writes its own valid journal;
after restart, an offline provider request must contain the early user and assistant context.
The original prefix and a frozen snapshot must remain unchanged, while continuation appends.
This tests native persistence and context transport without paid/external model calls. It does
not establish that a particular real model recalls the context correctly.

The large mode refuses unbounded cgroups. First verify that the Docker VM has at least 1.5–2 GiB
of available memory beyond existing workloads; otherwise defer the large probe without stopping
other services. On the Docker host, use a fresh bounded container with
no credentials, real volumes or published ports. Supply an already-built image; do not pull latest:

```sh
docker run --rm --network=none --read-only --tmpfs /tmp:rw,size=256m --memory=1g --memory-swap=1g --cpus=1 --pids-limit=128 --mount type=bind,source="$PWD",target=/work,readonly --entrypoint /usr/bin/tini <verified-local4-image> -g -- node --v8-pool-size=1 --max-old-space-size=128 /work/bridge/scripts/native-long-resume-smoke.mjs --codex=/opt/codex/node_modules/.bin/codex --items=40000
```

Record exact native version, record/message counts, memory/PID peaks and exit. Full display read
must hit HISTORY_READ_LIMIT while pages and native resume work. This probe uses native directly;
also continue a valid long native session through the lab gateway, page older history during a
live reply, and confirm original context and UI. These remain separate acceptance gates.

Rollback stops only this lab and restores its retained previous images/Compose configuration,
without removing volumes. Do not deploy local.4 to working Harness/HA until the outstanding gates
pass. A failed case must preserve logs and resource evidence with secrets removed.
