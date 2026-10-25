# local.6: release identity, cached geometry and native gateway/MCP integration

Branch: `fix/lab-continuity-local6`, based on local.5 `38d5c4e3f5d447c9eacf22f03cc4823bab0bdea0`.
The existing memory/history budgets, native permission policy, queue, Stop, limits and lifecycle
behavior remain. No working gateway, account configuration, project or Home Assistant was changed.

## What changed

- Authenticated health previously contained a stale local.4 string even in local.5. It now reads the
  owning root package manifest. Both health aliases are tested against package/release metadata;
  assembly also imports the actual staged runtime metadata and compares it with the staged manifest.
  Gateway and web package versions must agree before release assembly.
- A stored multiline draft changed composer height after cached-tail positioning, causing a real
  45px gap. Autosizing now notifies the transcript to settle its existing tail intention in the same
  frame. One content and one viewport observation cover subsequent geometry changes before paint.
  The observer follows initial-tail/live intention only; pointer/history/upward-scroll interaction
  retires idle settlement. Message rendering remains memoized independently of draft keystrokes.
- Delayed status metadata also changed the phone row from 22 px to 24 px. The row reserves 24 px and quota
  text stays on one line. This fixes the remaining observed 2 px frame without loosening the 1 px test.
- The full-app browser smoke now has a stored multiline draft, delayed quota data, repeated view
  switches and a real synthetic external SSE append after scrolling up. It records all sampled
  geometry and failed coordinates plus screenshots into an explicit persistent output directory.
- `--gateway-continuation` extends the existing bounded native fixture with the actual candidate
  launcher, checksum-pinned hardened adapter and authenticated HTTP/SSE. It stages only public code,
  uses a private native HOME, waits for real native index backfill without editing databases, and
  pages history while the synthetic provider holds the live reply active. A compatibility HTTP read
  must stay bounded at 200; the owned tail stays at most 202 after the new user/assistant pair. The genuine
  full source-loader read still must reject at HISTORY_READ_LIMIT. No limit/deadline was increased.
- The readonly MCP probe configures only a disposable native HOME, then continues through the real
  gateway with the normal empty ACP MCP list. It selects a tool the native runtime actually
  advertised, invokes a real dependency-free stdio MCP server, and verifies the unique result in
  native tool output and a completed HTTP tool part. It neither installs a server nor changes user
  MCP configuration. [MCP_SETUP.md](MCP_SETUP.md) documents normal setup and remaining limits.

## Completed local checks

| Check | Evidence |
| --- | --- |
| Serial bridge suite | 831/831 passed, empty temporary HOME/CODEX_HOME, CODEX_PATH unset, 256 MiB heap, small Node/libuv pools. |
| Full web suite | `npm --prefix web run test:ci:full` passed, including desktop and existing cached/queue/attention regressions. |
| Production build | TypeScript and Vite passed; existing >500kB main-chunk advisory remains. |
| Geometry regression baseline | Enhanced smoke failed against local.5 with 45 px gaps; an intermediate fix exposed a separate 2 px status-row change. Both were retained as failing evidence, not counted as passes. |
| Final production UI stress | 3 rounds ×4 viewport/theme cases, 12/12 passed. 770 sampled cached-content frames, zero beyond the unchanged 1 px tail tolerance. Stored drafts, same-session activation, delayed metadata, inner focus reset, 28 px attachment pills, menus and viewport bounds passed. |
| Reader preservation | A synthetic external SSE message triggers an actual delayed HTTP re-read while the reader is at the top; all 12 cases remained at scrollTop 0. |
| Actual gateway small 64 | Codex 0.163.0, candidate local.6 and hardened adapter 1.13.1; 140 original records/65 displayed source messages, 2 loopback provider requests, 5 pages during the busy continuation, 67 unique combined display IDs, bounded HTTP windows, source prefix/snapshot and early native context preserved. Measured 5476 ms. Development evidence only. |
| Actual MCP | Native 0.163.0 → real local stdio tool → hardened ACP → actual local.6 gateway. Unique marker reached native tool output and completed HTTP tool part, 5 message invalidations, 3 synthetic provider requests, preserved source/context. Direct native 5155 ms and a disposable Node CLI wrapper 5110 ms both passed. |
| Focused native fixtures | 16 cases passed, including bounded staging, completion gate, namespace-aware MCP tool selection, failure artifacts and readonly server behavior. |

The model endpoint in these native integration probes is synthetic and loopback-only. There is no
API key, paid response, installed MCP package, external service or claim of real-model semantic
recall. The stdio MCP result is produced by the actual child server and must appear in the next
native provider request; it is not supplied as a fabricated model answer.

Detailed local logs/artifacts remain outside Git under `/tmp/local6-*`. UI JSON and images can be
written directly to a host log mount with HARNESS_UI_ARTIFACTS_DIR, avoiding Docker tmpfs loss.

## External lab evidence and open gates

The user's local.5 Mac lab passed the bounded native-only 40k probe: 40,000 items, 80,012 records,
40,001 display messages, 112.1 s, peak 509,440,000 bytes and 47 PIDs; original prefix/snapshot and early
context were preserved. Its exact-image lifecycle check passed 5/5. This is meaningful prior evidence;
it does not prove local.6's extra real-gateway phase at 40k. The local.5 soak completion report is
still pending; do not infer success from elapsed time.

Before working/HA deployment, repeat [LOCAL_6_RETEST.md](LOCAL_6_RETEST.md) on the immutable candidate:

1. Correct 40k native-generated resume through actual gateway, pages during the active reply and
   bounded aggregate resources: 1 GiB/no swap/1 CPU/128 PIDs. This environment lacks an enforced cgroup,
   so large mode remains unsupported here. Do not raise limits or change journals/index flags.
2. Target Docker kernel sandbox remains unavailable (`unshare`/`bwrap` rejected). The policy denies
   escalation, but MCP success does not make local shell/file sandboxing operational.
3. Physical phone keyboard/rotation/images, live multiple machines/agents, hidden-tab quota polling,
   PID pressure (prior peak 122/128) and updated resource/soak results remain separate checks.
4. Arbitrary-child whole-cgroup OOM still needs external host policy; the Compose template does not
   set memory.oom.group. The inherited five lifecycle scenarios must be repeated on the exact image.
5. The MCP proof covers a local readonly stdio tool. Remote HTTP/OAuth, interactive elicitation,
   approval-requiring tools and ChatGPT plugin widgets are not accepted by that result. Remote
   server authorization governs remote actions; the local filesystem sandbox does not contain them.
