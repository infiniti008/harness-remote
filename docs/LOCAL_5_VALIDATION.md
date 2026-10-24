# local.5: UI corrections and native fixture diagnostics

Candidate branch: `fix/lab-polish-local5`, based on clean local.4 `fa10d6615d5ed43f7b4b74494a067bc93e486489`.
All local.4 permission, queue, Stop, limits and history-budget behavior is retained. This is a lab
candidate, not an accepted deployment for the working Harness or Home Assistant.

## Fixes and evidence

- The full app's `.tdw-shell textarea:focus-visible` important shadow defeated local.4's local reset.
  The targeted reset now wins without removing the outer composer's focus indication.
- The late `beautiful-ui-controls.css` attachment padding also overrode the base stylesheet.
  Both layers now produce a 28px pill, retaining the 24px remove control and expanded touch target.
- Global navigation has a shared icon/label/shortcut grid, a separate context/status area and bounded
  overflow. Mobile rules formerly hid breadcrumbs/status and changed Refresh into an icon-only
  control; the compact disclosure explicitly restores these. Focus controls use the same menu-row
  component styling rather than inheriting an icon button's geometry.
- Cached native opens used a fresh runtime anchor dated now, which excluded cached earlier messages
  from the timeline until a network revalidation reconstructed real turn boundaries. The runtime
  now seeds those boundaries from the same scoped, bounded idle feed before its first snapshot.
  The first authoritative read still discovers external additions; busy sessions and other account
  identities cannot use that seed. The transcript waits for content before consuming activation,
  and automatic scroll uses instant/default-auto positioning; explicit jump buttons retain smooth
  navigation. Passive updates still preserve a reader's position.
- The lifecycle smoke now signals through the shell builtin with validated positional arguments;
  it no longer assumes `/bin/kill` exists in Debian slim.
- The offline large-native fixture now measures phases, provider events/backpressure, native RPC
  traffic, rollout bytes and owned process/thread topology. Completed-turn full item payloads are
  discarded and rollout prefix/count verification streams from disk. The default finalized-item
  stream emits 40,002 SSE events for 40,000 messages instead of 240,002; the legacy delta form is
  still selectable for comparison. Both require native-generated records, paging and preserved
  original context. No read, memory, PID or deadline limit was increased.
- Failure diagnostics retain at most 8MiB of synthetic rollout excerpts plus bounded metadata.
  An optional external artifact directory supports a dedicated host log mount, avoiding loss when
  Docker tears down `/tmp` tmpfs. Success writes no artifacts; no account HOME/config/database is
  exported. The fixture disables unrelated plugin/app/skill/shell-snapshot startup and Git network
  protocols. These fixture controls do not change a user's production Codex configuration.

## Validation scope

The actual-app browser check is `web/scripts/local5-workspace-smoke.mjs`, not the older isolated
conversation component fixture. It opens the real app entry, CSS shell, native adapter/controller
and markdown renderer. Only HTTP/SSE transport data is synthetic, in new incognito CDP contexts.
It switches two 200-message sessions while revision reads wait 700ms, samples every visible frame,
checks same-session activation, reader preservation, focus, valid PNG attachment height and global
menu alignment/bounds. Desktop/phone light and dark plus narrow desktop and touch landscape are
included. Screenshots are synthetic; they do not demonstrate a physical phone or live model.

Completed here on Node24.21.0:

| Check | Result |
| --- | --- |
| Serial bridge suite | 826/826 passed with empty temporary HOME/CODEX_HOME, CODEX_PATH unset, 256MiB Node heap and small worker pools. |
| Full web suite/build | `test:ci:full`, including desktop tests and the cached-runtime regression, passed. TypeScript/production Vite build passed; the existing >500kB chunk advisory remains. |
| Actual-app Chromium, production build | Six cases: 1440×900 and390×844 light+dark,1024×768 light,844×390 light with touch emulation. Every sampled visible cached-content frame started at its current tail (57–78 frames/case); same-session activation also passed. |
| Full-shell focus/attachments/menu | Inner outline/shadow none, outer border retained; attachment28px/remove24px; all menu labels aligned and panels within viewport; no horizontal overflow or JS exceptions. |
| Cached adapter runtime | Synchronous first snapshot, authoritative external append, busy-session and account isolation regressions passed. |
| Diagnostic/lifecycle helper unit tests | Ten focused cases passed: native failure phase, bounded private exports, unrelated file preservation, complete fixture HOME cleanup and validated shell signal arguments. |
| Actual native permission regression | Pinned Codex0.163.0 and adapter1.13.1, four loopback synthetic requests: workspace write succeeded here, forbidden file absent, native Never rejection observed. This does not establish the Mac Docker kernel sandbox. |

Synthetic menu previews: [desktop](previews/local5-menu-desktop.png), [phone-sized](previews/local5-menu-phone.png).

The pinned Codex0.163.0 small offline run with 64 outputs passed: 140 native records, 65 display
messages, two loopback requests, unchanged original prefix and snapshot, resumed early user and
assistant context. A measured run took 659ms. This is protocol development evidence only, not a
40,000-message acceptance result. Warm small-run timing cannot establish a large-run speedup.

Owned native topology samples contained about 28–29 threads, including Tokio and SQLite workers.
`TOKIO_WORKER_THREADS=2` is not an aggregate process/thread limit. The Mac's reported PID pressure
has not been reproduced or solved here; its existing cgroup bound remains unchanged. Development
smoke children use a small Node/libuv worker pool. Production tools' environment is unchanged.

## Open acceptance gates

Use [LOCAL_5_RETEST.md](LOCAL_5_RETEST.md) to update only the existing isolated Mac lab.

1. Full 40,000 native-generated messages under enforced 1GiB/no swap/1CPU/128PIDs, followed by valid
   native resume and live gateway continuation. local.4's 120s timeout remains a failed gate; the
   smaller SSE stream and new diagnostics are changes to test, not proof of success.
2. Target-host kernel sandbox. The Mac lab rejects user namespaces; native policy denies escalation
   but does not make bubblewrap work. No privileged mode or Full access workaround is introduced.
3. Rerun the five Docker lifecycle cases with the fixed current script. The prior report's 5/5
   lab-patched-copy result is evidence for local.4's boundary, not execution of the local.5 script.
   Arbitrary-child whole-group OOM still requires an external host policy; Compose does not set it.
4. Physical phone, live multiple-agent/machine behavior, hidden-tab quota polling, PID pressure and
   an updated soak/resource report. The reported successful local.4 offline soak is retained as
   prior evidence, not substituted for a native long-resume test.

Working gateway/web and HA were not modified. Detailed local test logs remain outside Git under
`/tmp/local5-*`; record the external lab's own immutable source, images, versions and results.
