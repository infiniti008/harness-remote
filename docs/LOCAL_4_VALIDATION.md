# 3.5.0-local.4 validation

Prepared 2026-10-24 on branch `fix/lab-hardening-local4`, based on local.3
`e94a90dc1877af20e9552597eb1c8830f32533f3`. Exact candidate commit is in release.json.
No working gateway/web restart, HA access, real home migration or paid model call was performed.

## Implemented

- Native Codex permission policy is enforced at the actual adapter→app-server boundary, including
  start/resume/fork/turn overrides. Never/user/workspace-write replaces the vendor's auto-review;
  Full access presets and unsolicited native approval grants are disabled. The original vendor
  bundle is checksum-checked and transformed in memory, without altering installed caches.
- New prompts queue by default. Existing entries can be edited, removed or explicitly sent now
  through native steering. Promotion uses the same user/message identity, serializes against
  queue claims, preserves attachments and orders the promoted user row before its reply. Unknown
  steering delivery never triggers automatic replay. Stop remains a separate operation.
- Account limits reuse the native connection. A 60-second coalesced cache, bounded RPC timeout,
  selected-machine scoping, hidden-tab polling pause, honest unavailable values and exact quota
  window durations avoid history scans, extra sessions and guessed percentages.
- Composer focus uses only the outer border; model/select centers align; image lightbox is portaled
  to body with opaque surfaces. Cached session activation uses instant positioning before paint.
  Limits use a small disclosure with mobile bounds and Escape/outside dismissal.
- Unexpected native/adapter death terminates this candidate's gateway, allowing the external
  container/systemd boundary to remove detached descendants. Intentional closes retain normal
  lifecycle behavior. Added offline lifecycle and native-history probes plus a systemd example.

## Completed local checks

| Check | Evidence |
| --- | --- |
| Bridge suite | 820/820 passed; serial Node24.21.0, 256MiB heap, CODEX_PATH unset. Initial inherited-path discovery failures disappeared in the hermetic run. |
| Web suite | `npm --prefix web run test:ci:full` passed, including controller runtime queue tests and desktop suite. |
| Production build | TypeScript and Vite passed. Existing >500kB chunk warning remains. |
| Native policy transport | Exact pinned codex-acp1.13.1 against an offline native transport: start/resume/load/fork/prompt, malicious policy overrides, mode refusal, unsolicited approval denial, account RPC reuse and native death. This is not a kernel sandbox test. |
| Actual native tool policy | Codex0.163.0 + real pinned adapter, fresh temporary HOME, loopback synthetic tool calls: workspace write succeeded; ordinary outside write and require_escalated did not create the forbidden file. Native Never rejection observed; four offline requests. This local result does not accept the Docker host kernel sandbox. |
| Queue HTTP | Auth401 before native reads, bounded limits cache, default queue, edit and promotion in place, repeat promotion409. |
| Queue races | Double promotion, completion race, unsupported steering, lost acknowledgement, promotion of a later entry, retained image/text identity. |
| Native offline protocol | Actual Codex0.163.0, four synthetic assistant outputs,20 native records,5 display messages, two loopback provider requests. Native resume used the same ID; early user+assistant context appeared in the resumed request. Frozen snapshot and original byte prefix stayed unchanged. Marked development_passed_not_acceptance. |
| Large-probe guard | Unbounded local cgroup returned unsupported_budget/exit2 without starting the large native case. |
| Chromium geometry/actions | Actual components on a synthetic fixture,1440×900 and390×844, light+dark. No browser exceptions or horizontal overflow. Cached tail positions2108/2108 and3420/3420. Textarea outline/shadow none,border0; outer focus border changed. Model/select center difference1px. |
| Chromium overlays/queue | Lightbox child of body,z1300,opaque panel/backdrop,focus inside and topmost center. Quota popover within viewport; mobile x32..358. Edit preserved two attachments; Send now acted on q1. Escape/outside closed quota disclosure. |

Synthetic UI previews: [desktop](previews/local4-desktop.png), [phone-sized](previews/local4-phone.png).
They are component fixtures, not evidence of a physical phone or a real model/tool run.

Local detailed logs are outside Git: /tmp/harness-local4-{bridge,web,build,ui,native-fixture}.log.
Retain the external lab's own logs and image digests when repeating acceptance.

## Still open — do not claim production acceptance

1. Actual host bubblewrap/user namespace availability and an allowed workspace write plus outside
   write denial. Native-policy transport checks do not prove the kernel sandbox works. A failed
   namespace must stay a blocked tool; automatic escalation must not recreate the old test file.
2. 40,000+ native-generated display messages resumed under the pinned native executable and enforced
   aggregate limits. Also verify gateway continuation and paging during that long live turn.
   Four-output protocol success is not a long-session memory proof.
3. Whole-container teardown tests for gateway TERM/SIGKILL, adapter/native death and native OOM.
   The Docker smoke returned skipped because no usable daemon/image exists here. Arbitrary-child
   whole-cgroup OOM requires memory.oom.group=1 or equivalent supervisor policy; not set by Compose.
4. Physical phone keyboard/rotation/image interactions, live multi-harness UI and a completed
   local.4 resource/soak run. Prior local.1/local.3 reports do not satisfy these new gates.

Use LOCAL_4_RETEST.md for isolated deployment/rollback. Working Harness and HA remain outside this
candidate's acceptance scope until these results are recorded.
