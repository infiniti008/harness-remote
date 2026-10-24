# Harness Remote local candidate

This is an experimental build based on Harness Remote 3.5.0, with separately preserved local changes.
It is not the upstream npm release and is not approved for Home Assistant deployment yet.

## Receiving upstream updates

The maintained fork is https://github.com/infiniti008/harness-remote; its upstream is
https://github.com/giuliastro/harness-remote. The fork's `main` branch is an upstream mirror;
`local/memory-safety` holds the reviewed local patches. Official `v*` tags retain their upstream
meaning. Never overwrite or force-sync the maintained branch with upstream's tree.

For each stable upstream release, create an integration branch from the maintained branch and
merge the official tag. Resolve overlapping changes while preserving upstream fixes and local
read/cache limits. Align the candidate versions, lockfiles, embedded version, distribution defaults
and `build-release.py`'s upstream commit. Run bridge and web checks, bounded long-history and
writer-adoption tests, then build and verify matching gateway/web artifacts. Advance the maintained
branch only after those checks pass. Published commits are merged forward, not rebased away.

The current integration target is upstream `v3.5.0` (`4463fcfa02d35c77177b762f04ba6841fc168107`).
Scheduled update detection and automatic update pull requests are not configured yet. They should
prepare an integration proposal; conflicts or failed checks must block promotion. Updating installed
services remains a separate step with a retained previous version. Running `npx harness-remote@latest`
installs upstream's npm package and does not install this fork's patches.

## Artifacts and installation

`harness-local-<version>.tgz` contains the gateway, prebuilt web client, qrcode-terminal 0.12.0 and the
verified, unmodified codex-acp 1.13.1 JavaScript bundle. Node and the native Codex CLI are external.
The launcher requires the tested Node 24.21.0 and Codex 0.163.0 versions and downloads nothing at startup.
`harness-web-<version>.tgz` contains just the matching web client. `release.json` identifies its source.

Verify SHA256SUMS and extract into a new version directory. Run `node distribution/run.mjs --check`
there before starting anything. A gateway command has this shape (replace paths and origin):

```
node --max-old-space-size=256 distribution/run.mjs --host 0.0.0.0 --port 4902 --root /path/to/project --state-dir /path/to/gateway-state --cors http://your-web-client:5300
```

The launcher inherits CODEX_HOME, HOME and credentials without changing them. It never restores,
copies, deletes or migrates an agent home. Its state directory is separate from release binaries.
No automatic service installation, restart loop or machine pairing is performed by extraction/check.
Authentication settings must be supplied through the existing daemon options/environment.

The preflight reads `state_5.sqlite` in read-only mode. It requires `backfill_state.status=complete`:
a missing/unfinished index is not initialized by this launcher. `CODEX_SQLITE_HOME` is respected;
a `sqlite_home` override inside native config must be supplied as `HARNESS_CODEX_STATE_DB` for inspection.
The check never resets leases or rebuilds data.
This is a startup guard, not a guarantee that native resume or later metadata scans fit in memory.

Serve the web artifact from the existing web server after testing it on a separate URL. Check its
`release.json` against the gateway candidate. The revision protocol is additive: an older gateway
returns a normal page and the client continues without conditional caching. Do not silently combine
untested client/server versions in a stable deployment.

## Resource isolation and rollback

The code bounds Codex journal viewing: 16 MiB maximum JSONL record, 32 MiB scanned per page,
4 MiB estimated retained page text, 64 MiB scanned/8 MiB text/10,000 messages for a full read,
one cold read plus eight queued reads per loader, and 20 seconds of cooperative read processing.
These are application budgets, not kernel memory limits. Native Codex resume and session discovery
are outside these budgets. A long agent turn is not subject to the journal-read time limit.
The upstream 3.5.0 external-activity probes also have a scanner-level 2 MiB read/record budget
and a 2-second cooperative processing budget, including journals with a single oversized record.
An inconclusive probe supplies no external busy evidence; it never overrides bridge-owned busy.

Use a container cgroup or a systemd unit that limits the whole subtree before production use.
Node heap flags do not cap native Codex. POSIX adapter process groups clean up descendants on normal
close or wrapper exit. Whole-instance cleanup, including descendants that call `setsid()` and gateway
SIGKILL, requires the container PID namespace or systemd control group described in
`docs/LOCAL_4_NATIVE_SAFETY.md`. The candidate stops on unexpected adapter/native death, with no
automatic restart; intentional client close and pool eviction retain their normal paths.
Do not launch this candidate unbounded on the HA host that previously exhausted memory.

Keep the previous release directory. Rollback means stopping only the candidate service and
selecting the previous program version. This release introduces no history/database migration;
rollback does not undo agent actions or changes to external data. A separate HA app would require
an explicit data-access plan: it cannot see the SSH app's private `/root/.codex` automatically.

## Build and publication

Review source changes; run serial bridge tests, focused web tests, the web type check/build and
bounded real-chain memory tests. Commit the result. `python3 distribution/build-release.py` assembles
allowlisted code/assets and verifies downloaded dependency archives against pinned checksums.
Build twice and compare artifacts. It excludes `.codex`, auth, sessions and machine state by construction.

The candidate GitHub workflow builds downloadable artifacts only. It does not publish npm packages, GitHub
releases, Pages, images or desktop applications. Upstream workflows are retained as `.upstream`
references until a fork owner and explicit publication configuration are selected. The original PR
validation workflow remains enabled and uses the candidate's required Node version.

`distribution/Dockerfile` and `distribution/compose.yaml` are unbuilt Linux/NAS templates. They install
the lock-file-pinned native Codex and propose a 1 GiB aggregate memory limit, no swap, one CPU, 128 PIDs
and no automatic restart. These values still need real writer/MCP workload tests. Supply an existing
Linux Codex home and project root; both are mounted at their original absolute paths. Set the UID/GID
to match their owner. This is not an installation recipe for HA Supervisor and does not access the
SSH app's private filesystem. Docker was unavailable in the local lab, so the image is not validated.

Remaining release gates: sustained real-chain testing, full browser interaction checks, an enforced
aggregate memory/CPU limit on the deployment host, Linux amd64/macOS checks, and an installation/
rollback rehearsal. An HA app and a container image are separate later deliverables; neither is
validated by this portable archive.

## Candidate 3.5.0-local.2 and remaining lab gates

Codex writer acquisition now reads only a 200-message display seed and calls native
`session/resume` with the original session id. It neither supplies that seed as model context nor
rewrites the native rollout. Older history remains accessible through journal pages while the
writer is active; those pages never expand the live transcript cache. Full-read and oversized-record
budgets remain unchanged. Adapters without advertised resume support fail explicitly rather than
falling back to a full replay. Native Codex's own resume allocations still require aggregate limits.

Stop retains the writer guard until the original prompt RPC finishes or its process exits.
Cancellation is retried every 500 ms for up to 30 seconds to catch a turn that starts after the first
cancel. HTTP Stop waits up to five seconds for confirmation; otherwise it returns 503 and the Session
remains stopping. New prompts are rejected with 503 while stopping, including prompts queued before
Stop during preparation. Late output from the cancelled turn is ignored. An additional Stop can
retry a failed cancellation. This behavior is confirmed by fake-adapter regression tests; real
Codex timing must still be repeated in the isolated Docker lab.

The candidate launcher forces ACP permission mode to deny, overriding allow profiles. The checked
adapter wrapper additionally enforces native `never`/`user`/`workspace-write` on startup and every
thread start/resume/fork and turn start. The old ACP-only deny setting did not prevent the adapter's
default native `auto_review` from approving an escalation. Full access is disabled and unsolicited
native approval requests are declined. See `docs/LOCAL_4_NATIVE_SAFETY.md` for the exact boundary and
offline native-chain/lifecycle checks. The Docker template includes
bubblewrap, but package installation alone does not enable user namespaces on the host. If bwrap
cannot create its namespace, a tool failure must remain a failure: do not enable privileged mode,
use a bypass flag or approve escalation to obtain a passing test. This change does not establish
that Linux workspace isolation works. Verify an allowed write and a blocked write outside the
workspace on the actual Docker host before trusting tool execution.

The user's isolated arm64 Docker lab passed a four-hour offline soak on local.1, but found the long
resume, early Stop and automatic escalation blockers addressed here. That external result is not a
local.2 acceptance result. Repeat the focused cases described in `docs/LOCAL_2_RETEST.md` before
promoting this candidate. Home Assistant deployment remains blocked on that acceptance and an
explicit installation/rollback rehearsal.

## Compact workspace candidate 3.5.0-local.3

The `ui/compact-session-layout` branch adds a compact Session header, sidebar navigation disclosure
and a growing single-line composer with internal action buttons. Desktop model controls share the
input surface; narrow phones place them on the existing small status line. See
`docs/COMPACT_WORKSPACE.md` for synthetic screenshots, measured dimensions and the isolated lab
checklist. This candidate includes local.2's backend fixes; the outstanding native/sandbox acceptance
gates still apply. Updating the working deployment is a separate step.

## Lab hardening candidate 3.5.0-local.4

See `docs/LOCAL_4_VALIDATION.md` for completed and outstanding checks, and
`docs/LOCAL_4_RETEST.md` for an isolated Mac lab upgrade, lifecycle smoke and native long-resume
probe. This candidate includes the earlier memory/history, native resume, Stop and compact UI
changes. It additionally enforces native permission policy, queues new messages by default,
adds explicit queue promotion/editing and account limits, fixes overlay/focus/activation behavior,
and fails the isolated service on unexpected adapter/native death. Keep the same resource bounds
and restart=no. Kernel sandbox, large native resume, container teardown and physical phone gates
remain required before any working/HA deployment.

## Lab polish candidate 3.5.0-local.5

See `docs/LOCAL_5_RETEST.md` for the isolated upgrade and `docs/LOCAL_5_VALIDATION.md` for scope and
evidence. The full app's focus/attachment cascade and mobile menu geometry are corrected; cached
native opens prepare turn boundaries before rendering their first history window. The current
lifecycle test uses shell builtin signals. The bounded offline native probe adds phase/resource
diagnostics, a smaller finalized-message stream and persistent, allowlisted failure artifacts.
All local.4 runtime policy, queue and Stop fixes remain. Do not raise the existing limits or deploy
to working Harness/HA: large native resume, target-host sandbox and physical-device gates remain.
