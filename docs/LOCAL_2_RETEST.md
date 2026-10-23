# local.2 lab retest

Use only the existing isolated test Compose project, its own volumes and credentials. Do not
restart, mount or alter the working Harness, working web, real agent homes, Docker socket or HA.
Keep the gateway's verified aggregate 1 GiB / no extra swap / 1 CPU / 128 PID limits and restart=no.
Keep existing tested host port mappings, after checking they still belong to this test project.
Record gateway/web source commits and SHA256SUMS; both artifacts must be local.2 from one commit.
Never put credentials, native auth files or private transcript contents in reports or Git.

1. Rebuild the candidate and web, verify checksums and version metadata, and recreate only the
   test gateway/web. Preserve the test volumes and separately obtained test login. Verify cgroups,
   `RestartCount=0`, `OOMKilled=false`, preflight readiness, authenticated health and the old services.
2. Continue the native test Session with 40,000+ records. Page all records without duplicates or
   gaps, send a short prompt and verify a correct answer. Ask for an exact marker set in an earlier
   genuine model turn to demonstrate native context retention. Use a real native conversation for
   this context check: fabricated UI event messages alone are not model conversation items.
   Require no HISTORY_READ_LIMIT, no full display-history read/replay, no rollout rewrite, and no
   OOM. Read older pages during a live turn and then verify the live tail remains correct.
3. Reproduce Stop immediately after Send, during preparation and after streaming begins. Repeat
   at least 20 times with different timing. Stop may return 200 only after native teardown; a
   timeout must return 503 and reject the next prompt while stopping. Require pendingRequestCount=0
   after acknowledged Stop, no old text after Stop, and the next prompt answering its own NEXT
   marker without old-story fragments. No gateway restart or second Stop should be needed in the
   normal timing cases. Check a different Session continues during an unconfirmed cancellation.
4. Verify a new short Session, its second turn, refresh, switching away/back, and continuation after
   recreating only the test gateway. Confirm no replay duplicates and no newly exposed real homes.
5. Verify sandboxing independently. Check bubblewrap/user namespace support inside the same gateway
   container. A command may write inside /projects/model-probe under workspace-write; writing to a
   disposable location outside all permitted write roots must be denied (do not use /tmp, which
   may itself be permitted). Do not read real secrets for this
   test. An ACP escalation must be cancelled even if the adapter offers allow_once/allow_always.
   If namespace creation fails, record tools as blocked; do not grant privileges or approve a bypass.
6. Record peak aggregate cgroup memory/PIDs, CPU and error/pending counts for these real-chain cases.
   Offline page-cache soak figures do not substitute for native resume or model/tool measurements.
   Test actual phone access after these gates, using only the test web origin.

If a gate fails, stop the case, preserve logs and report the exact reproduction with secrets removed.
Do not raise history limits, remove sandbox constraints, change the working deployment or test on HA.
