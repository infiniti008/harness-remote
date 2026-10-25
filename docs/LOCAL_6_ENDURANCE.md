# local.6: native Stop, resource plateau and reconnect probe

Runtime under test: clean local.6 production sources at
`6c5832e14e221e801ae2cfc5cfb24c949d75adec`. This branch adds a diagnostic script and this document;
it does not modify `bridge/src`, `distribution/run.mjs`, package versions or the candidate images.
The immutable local.6 archives remain unchanged. No working gateway, native home, login or HA data
is used by the probe.

## Actual result on the current Linux working host

`bridge/scripts/native-endurance-smoke.mjs` passed with real Codex 0.163.0, checksum-pinned hardened
ACP 1.13.1, the actual staged candidate launcher, private HOME/workspace and a synthetic loopback
Responses server. No account or paid model call is involved. Plugins, apps and external MCP servers
are disabled in that private fixture; this is not the user's complete configured tool stack.

| Scenario | Measured result |
| --- | --- |
| Stop followed by NEXT | 20/20 cycles passed; all 20 provider requests had actually started. Each NEXT produced its own completed reply, with no pending `session/prompt` afterward. Half of the cycles explicitly wait for the provider; the others retain the early-Stop timing. |
| Owned process tree | Three live processes throughout the 20 cycles: gateway, adapter and native. No process-count accumulation. |
| Threads | Warm baseline 54 tasks, after 20 cycles 57, peak 57. Idle samples: 54, 55, then 57 for the remaining 18 cycles. Native SQLite workers grew 13→15 and Tokio workers 22→23; gateway/adapter threads stayed 8/4. This observed plateau is evidence against accumulation in this scenario, not a diagnosis of the Mac's 128-PID event. |
| Memory | Peak summed gateway-tree RSS 546,456 KiB (~533.6 MiB). Warm baseline ~500.9 MiB; after the cycles ~522.2 MiB. Shared pages can be counted more than once; these are process RSS measurements, not cgroup accounting or a proof of a flat multi-hour memory curve. |
| Silent response and reconnect | 65,085 ms after the initial native text, 13 busy/pending checks, exactly one provider request. The SSE client disconnected, reconnected and disconnected during the pause, then reconnected for completion. The response completed and a following prompt worked. HTTP/SSE transport was exercised, not a physical browser or phone. |
| Activity resets the idle watchdog | In a separate restarted gateway, test-only idle budget 1,500 ms; actual native output every 500 ms kept a 4,023 ms response alive. |
| Native idle cancellation | Under that same test budget, a silent provider response was cancelled; gateway became idle, native pending cleared, a timeout error was retained in history, and RECOVERED completed. The shipped 30-minute default was not changed. |
| Shutdown | Both gateway shutdowns had zero tracked descendants remaining after grace, no forced descendant cleanup and no sampling errors. PID identity uses `/proc/PID/stat` start time; no broad `pkill` is used. |
| Diagnostics | 933 process samples and 47 total synthetic provider requests, including bootstrap, all interrupted requests and recovery checks. |

Local artifacts: `/tmp/local6-endurance-full-znjqpyv2/{report.json,processes.ndjson,driver.log}`.
A preceding two-cycle, one-second development probe also passed; it is not the acceptance run.
A separate portability probe ran from the extracted immutable local.6 package with only this new
script added, using a disposable Node wrapper around the pinned native executable. Two cycles,
one-second reconnect and the accelerated watchdog passed: four processes, 58→61 tasks, peak 61,
peak summed RSS 581,844 KiB. This checks packaged dependencies and wrapper process handling;
it is not the actual npm CLI wrapper or a substitute for the bounded Mac run. Its artifacts are
`/tmp/local6-endurance-packaged-gtq7oipx/`.
Working web 5300 remained HTTP 200 and working gateway 4097 remained HTTP 401 without credentials.

The current shared desktop has **no enforced per-instance cgroup memory/CPU/PID cap**. This run used
`--development-small`, a 180-second watchdog and private native/gateway per-process address-space
and CPU limits. Those do not provide aggregate 1 GiB/128-PID isolation. A 65-second native pause and
an accelerated watchdog check also do not certify an actual five-hour model task or 30 minutes of
real silence. Existing fake-clock regressions cover the default watchdog semantics separately.

## Repeat on the Mac lab with the actual resource controls

Use a separate clean diagnostic checkout of branch `test/local6-native-endurance`. Record its exact
commit. Verify production runtime sources are still the accepted local.6 sources:

```sh
git diff --exit-code 6c5832e14e221e801ae2cfc5cfb24c949d75adec -- bridge/src distribution/run.mjs package.json package-lock.json distribution/Dockerfile distribution/compose.yaml
```

Use the already verified local.6 gateway image by immutable image ID. Run the script from a temporary
copy of the packaged candidate, which already contains its reviewed dependencies. The test does not
build an image or modify the live lab volumes:

1. Verify and extract `harness-local-3.5.0-local.6.tgz` into a fresh private diagnostic directory.
2. Copy only `bridge/scripts/native-endurance-smoke.mjs` from this diagnostic checkout into the
   extracted candidate at the same relative path. Its imports and pinned adapter already exist in
   the packaged candidate. Do not change runtime source files or the archive.
3. From that extracted candidate root, create a fresh host artifact directory and run the exact
   accepted local.6 image with these limits. Replace `<verified-local6-image-id>` with its recorded
   immutable ID. Do not run this with `docker exec` inside the active gateway.

```sh
lab_logs="/Users/nikitenok.sl/harness-lab-20261023/logs"
artifact_dir="$lab_logs/local6-endurance-$(date +%Y%m%d%H%M%S)"
mkdir -m 700 "$artifact_dir"
container="harness-local6-endurance-$(date +%Y%m%d%H%M%S)"
docker run --name "$container" --network=none --read-only --tmpfs /tmp:rw,exec,size=256m --memory=1g --memory-swap=1g --cpus=1 --pids-limit=128 --mount type=bind,source="$PWD",target=/work,readonly --mount type=bind,source="$artifact_dir",target=/diagnostics --entrypoint /usr/bin/tini <verified-local6-image-id> -g -- node --v8-pool-size=1 --max-old-space-size=128 /work/bridge/scripts/native-endurance-smoke.mjs --codex=/opt/codex/node_modules/.bin/codex --cycles=20 --pause-ms=65000 --artifacts-dir=/diagnostics
```

No ports are published. `exec` is needed only on this disposable private `/tmp` for the native shim;
do not change the production gateway's mounts or sandbox. Omit `--development-small`: the probe
must refuse an unsupported cgroup budget. Do not raise limits, deadlines or test thresholds.

Keep the stopped container until recording exit status, OOM/restart state and cgroup peaks/events.
Then remove only that exact container. Preserve the host `report.json` and `processes.ndjson`,
especially on failure. Any PID-limit event or OOM during the probe makes the result failed.
Snapshots count all observed owned processes without silent truncation, keep known reparented
children by PID/starttime, and record thread names without command lines, environments or tokens.
Short-lived detached children that exist wholly between samples cannot be certified by ancestry
sampling; the previously passed container lifecycle/namespace tests remain separate evidence.

If the 128-PID event reappears, the per-process snapshots and cgroup events should identify its
contributors. If this isolated probe passes but the live lab still reaches 128, compare configured
plugins/MCP, additional sessions and concurrent diagnostic commands before attributing it to Stop.
Neither result justifies increasing the PID limit or deploying to HA automatically.
