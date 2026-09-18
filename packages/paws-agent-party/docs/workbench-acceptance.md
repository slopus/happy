# Approved compact workbench — acceptance record

## Scope
Real React workbench backed by Paws SDK and AgentParty storage, not the standalone simulated HTML. Based on approved prototype dc641612; preserves streaming/N-person debate from 9ac2d906. Bright theme, compact/collapsible navigation, overlay members, reusable/temporary configured agents, preset-only robot identity, images + text, deletion.

## Evidence before final review fixes
- Backend independent review: all findings addressed at 7b78725a, 103 tests.
- Full package suite: 146/146 tests with `pnpm exec vitest run --maxWorkers=2 --reporter=dot`.
- `pnpm typecheck` and `pnpm build`: pass. Vite reports a >500KB bundle advisory (24 embedded SVG presets contribute); no external avatar runtime dependency.
- Ego task space 122, run `party-workbench-20260918-ui`, controlled acceptance server at `http://127.0.0.1:57237/`, explicitly labeled **测试替身，非真实 Agent**.
- DOM verification: header 68px; members initially closed; collapse retains draft; member panel absolute-positioned, no timeline resize; keyboard @ selects without sending.
- Viewports 1440×700, 1280×600, 390×844: document dimensions equal viewport and composer bottom within viewport.
- Actual fixture API through UI: created room; submitted @ technical member and received persisted fixture reply; edited robot12 and real-readable fixture device; 24 preset options, zero avatar file inputs; invited temporary designer (room4, library3); uploaded/sent image+text, timeline image shown and composer image cleared.
- Screenshot consent asked but not answered; no screenshots captured/reported. No visual pixel-match assertion, no real remote Agent run claimed.

## Configuration boundary
The installed SDK exposes model discovery on existing sessions, not on bare machines. Existing-session results take precedence; without them UI labels the same Paws app fallback candidate IDs as presets, **not proven device capabilities**. Remote Codex may reject an unsupported candidate. Profile spawn effort choices match SDK SpawnSessionInput; broader per-turn-only efforts are not advertised for launching profiles. Directory browsing does not grant access.

## Release status
Implementation branch only; no merge, deployment, OTA, or production test performed. Existing deployed application is unchanged.

## Independent review follow-up
The complete-diff review requested six integration corrections: ordinary-work stop before deletion; device-scoped directory requests; selection of a newly created room; consistent current-profile avatars; authoritative room-list reconciliation after another client's deletion; actual execution-device identity in member details. All six were fixed in ffb882dc and independently re-reviewed with no remaining confirmed blockers in that scope. The inherited ambiguous-send retry issue remains outside this change: a lost POST response followed by a manual retry may duplicate a send.

## Final verification — ffb882dc
- Independent fresh package run: **28 files, 153 tests passed**, `pnpm exec vitest run --maxWorkers=2 --reporter=dot` (48.53s).
- Fresh `pnpm typecheck && pnpm build`: exit 0; bundle 516.54kB / gzip 143.10kB, non-blocking Vite chunk-size warning.
- Restarted controlled fixture with latest production bundle at `http://127.0.0.1:60888/`, same Ego task122 and run. New room selected immediately, initial draft empty, document did not overflow; switching back restored the old room's draft.
- Confirmed deletion of the newly created fixture room removed its sidebar entry while existing room and Agent library remained. This fixture-room deletion is irreversible locally; no remote session was deleted.
- Execution details showed `fixture-mac-mini.local · 在线`, `gpt-5.6-luna · low`, `/tmp` and the original session link.
- Final verified state was reported textually before closing Ego task122; no screenshots or visual-panel receipts were generated (consent unanswered). Fixture server stopped after verification. Local test URLs are not external handoff links.

## PR preparation follow-up
- Fresh suite runs exposed a first-open race: the passive room-change cleanup could close a member panel opened immediately after the header appeared. Moved only that cleanup to a layout effect, added an expanded-state regression assertion, and received independent approval of the fix.
- Corrected the external-deletion test to await fallback room selection (a separate asynchronous state update), keeping the same expected room rather than weakening the behavior.
- Fresh final suite: 153/153 passed across 28 files (41.72s). Typecheck and standalone `/agent-party/` production build/smoke passed; gateway suites passed 11/11. No production release performed during preparation.
