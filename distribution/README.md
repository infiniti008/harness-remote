# Harness Remote local candidate

This is an experimental build based on Harness Remote 3.4.0, with separately preserved local changes.
It is not the upstream npm release and is not approved for Home Assistant deployment yet.

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
a missing/unfinished index is not initialized by this launcher. A custom native SQLite location must
be supplied as `HARNESS_CODEX_STATE_DB` for inspection. The check never resets leases or rebuilds data.
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

Use a container cgroup or a systemd unit that limits the whole subtree before production use.
Node heap flags do not cap native Codex. POSIX adapter process groups clean up descendants on normal
close or wrapper exit, but cannot run a cleanup hook when Harness itself receives SIGKILL.
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

Very large full-history reads can now be rejected explicitly, including a resume path that asks the
bridge to seed its entire display history. A bounded display seed for writer adoption is not yet
implemented. The native model context is never truncated by these changes. A stable release must
cover writer adoption, older paging during a live turn and long resumes under the aggregate limit.
