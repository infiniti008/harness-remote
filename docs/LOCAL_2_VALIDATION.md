# local.2 source validation

This is a candidate for the isolated Mac lab, not acceptance for Home Assistant or production.

Changes relative to local.1:

- Native Codex continuation uses a 200-message display seed and original-id session/resume.
  Journal paging and full-read limits are unchanged; live edits cannot mutate the shared page cache.
- Stop waits for native prompt teardown, retries the early-cancel race, rejects prompts while
  stopping and invalidates prompts/steering that were waiting during preparation.
- The portable candidate launcher forces ACP permission denial. The Docker template installs
  bubblewrap, but actual user namespace support and workspace isolation remain host test gates.

Validation on Linux arm64, Node 24.21.0:

- Serial bridge suite: 803 passed, zero failures. External watchdog measured 231.6 MiB peak RSS
  for the test process tree, four processes maximum, and no remaining test processes.
- Full web suite including desktop tests: passed. Peak test-tree RSS 468.5 MiB, eight processes
  maximum, no remaining test processes. Type checking and production build passed separately.
- Focused Stop tests cover ignored early cancel, native acknowledgement before idle, rejection of
  the next prompt, cancellation timeout with a retained guard, late acknowledgement, late activity
  after the retry window, cancelled output filtering, and Stop during load before prompt dispatch.
- HTTP regression verifies abort does not return 200 before confirmation and prompt_async returns
  503 while stopping. Legacy OMP lifecycle tests still pass after draining the fixture's native turn.
- Synthetic 40,000-message regression keeps full reads rejected, resumes by native id without replay,
  reads all older pages during a live turn without duplicate ids, bounds the live transcript and
  leaves the source journal unchanged. An adapter lacking resume fails explicitly.
- The deny-policy regression verifies an allow profile cannot automatically select an ACP
  allow_once/allow_always option when launched under the candidate's deny policy.

Final focused resume and Stop checks were repeated after review. The test watchdog used 640 MiB
aggregate RSS, 768 MiB per-process data, one-CPU affinity, a wall-time cap and synthetic HOME values.
These are test safeguards, not proof of Docker cgroup enforcement or native-model memory bounds.

No real model calls, real user history, Home Assistant changes, working gateway/web restarts or
host sandbox changes were used in this validation. No four-hour soak was repeated for local.2.
The external local.1 soak report does not demonstrate local.2 real-model or sandbox acceptance.
Follow LOCAL_2_RETEST.md for the outstanding Docker/native/phone checks.
