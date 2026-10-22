# Independent Paws sessions

Implementation base: `6fec4a20`; branch/worktree: `independent-sessions` / `happy--independent-sessions`.

Users can ask their current agent to open two independent sessions for separate tasks. The agent calls the Happy MCP `start_session` tool once per task, with a unique stable `requestId`, `title`, full `prompt`, and optional absolute existing `directory`. Requests can execute concurrently. These are real daemon-managed Paws sessions with independent histories and worker processes. Filesystem isolation is not automatic: concurrent edits should use distinct worktrees.

The tool returns a `<happy-session>` JSON block containing the actual session ID and title. The agent includes it in its reply; MarkdownView renders an IndependentSessionCard. The card observes the existing session store for running, permission-required, completed, failed, and cancelled states, and opens the target via the shared useNavigateToSession hook. No status polling is added. Imported read-only history renders the block as inert text.

The daemon requires a tracked parent and fresh readable encrypted metadata. Codex managed accounts use a fresh machine grant and validate it against the parent's account audit before spawn (a changed device binding fails rather than switching accounts); local sessions continue using local authentication. Codex model/effort come from parent metadata. Codex and Claude runtime callbacks forward effective permissions and appended system instructions. Initial messages explicitly apply the permission override, including default-mode downgrades from a fresh Claude worker's yolo default. Unknown permissions fall back to read-only (Claude maps this to its normal permission-requesting mode). Application-bound and sandboxed parents are rejected rather than dropping their restrictions.

Repeated requests are deduplicated for the lifetime of the daemon. A failed delivery retains the created child ID; retrying the same request resends with the same local message ID. A changed payload using the same request ID is rejected. This in-memory registry does not provide deduplication across daemon restarts. A failure with sessionId means the child exists but task delivery was not confirmed. Do not create another task ID automatically. Requests are capped at 1000 entries per daemon.

## Validation on 2026-10-22

| Case | Result | Evidence |
| --- | --- | --- |
| Two independent task requests and isolated history launch options | Automated contract passed | daemon/independentSessions.test.ts |
| Bound account, model/effort, effective permissions and custom instructions | Automated contract passed | launcher tests and real Claude permission resolver regression |
| Failure/retry reuses child and message identity | Automated contract passed | launcher tests |
| MCP discovery, context forwarding and returned card | Real MCP transport test passed; daemon launch mocked | startHappyServer.independentSessions.test.ts |
| Local daemon endpoint validation and dispatch | HTTP test passed; worker spawn mocked | daemon/controlServer.test.ts |
| Markdown parsing, invalid/streaming blocks and inert imported history | Passed | utils/sessionLinks.test.ts and existing Markdown regressions |
| Two cards, status subscription, pointer/Enter activation | Ego browser passed with actual component and synthetic store/navigation adapter | e2e/fixtures/independent-sessions |
| Narrow light layout and desktop ginghamDark | Ego DOM/interaction check passed; no screenshot review | Same component fixture |
| Independent code review | Passed after permission and retry fixes | Reviewer in implementation session |
| Real models execute two child sessions | Passed on isolated daemon and real backend/account | Two distinct file replies match; execution intervals overlap; all three sessions completed with the same profile, model/effort and read-only mode |
| Actual App/Web card navigation and refresh | Passed in the full local Expo Web App connected to the real backend | Both cards open the corresponding real child replies; parent reload retains completed cards |
| Android native cards and touch navigation | Passed in API 36 emulator, existing development client loading this branch JS | Two real completed cards; ADB taps open distinct Alpha/Beta replies; system Back follows existing home navigation contract |
| Production activation and physical Android device | Not performed | No Web/CLI deployment, APK installation or OTA publication; physical phone remains untested |
| Android screenshot/video | Captured, decoded and delivered | Real native parent cards, child replies and touch-path recording; development-client validation only |
| PR and release | Not performed | Existing production installation unchanged |

Run the component fixture with `node packages/happy-app/e2e/fixtures/independent-sessions/serve.mjs`, then open its printed loopback URL with Ego. It uses real parser/card code, synthetic event-driven sessions, and a navigation adapter; it never launches production model tasks.

Before rollout, build and activate the matching CLI/daemon and App/Web versions. Existing running agents do not gain newly compiled MCP tools. Follow CLAUDE.md's stable daemon entry point and new-session smoke checks; worktree builds alone do not update the active installation. Verify two real, harmless delegated tasks from a new parent session, click both cards in the actual app, then confirm both independent replies and terminal statuses.

## Real integration corrections

The real Codex round exposed gaps that HTTP-only tool tests could not prove:

- The STDIO MCP bridge has its own fixed tool registry. `start_session` must be registered and forwarded there as well as in the HTTP server. A dedicated bridge regression now covers it.
- Native read-only execution uses approval policy `never`; unapproved MCP calls are rejected before Paws permission handling. Runtime MCP configuration now approves only the exact `start_session` and `change_title` first-party tools and retains the original filesystem sandbox. The installed Codex version's schema and implementation were checked before applying this per-tool setting.
- A `sourceSessionId` grant is pinned to resuming that same session, so it cannot attach a fresh child session. Fresh children now obtain a machine grant and explicitly validate it against the trusted parent metadata's account profile; a changed binding cannot silently switch accounts, even if local audit data is absent.

Real verification used an isolated temporary daemon home and machine binding, preserving existing daemons and workers. Two random input files were read by separate model workers; both replies matched, execution intervals overlapped, and no files were added to the task directory. The full local Expo App authenticated to the same account/backend, displayed two completed cards, opened each child's actual reply, and retained the cards after reloading the parent. This is a full local integration result, not a production deployment or native-device test.

Latest focused CLI regression: 48 tests passed across bridge, launcher, account lifecycle, HTTP control endpoint and MCP transport. Independent code review passed after these corrections.

## Android validation on 2026-10-22

The shared React Native card and existing navigation hook support Android without browser APIs or native-module changes. An API 36 emulator ran the installed development client with this branch’s Metro bundle against the real backend. It reused the completed real integration sessions above: this verifies native rendering, synchronized status and actual touch navigation, rather than another Android-initiated model launch. Both child replies matched their distinct markers. System Back returned home according to the existing native navigation contract.

Three native card/navigation tests, seven parser tests and seven OTA contract tests passed (17 total). Android Hermes export and TypeScript checking passed. Independent code and screenshot review passed. Screenshots and an actual ADB screen recording were delivered; the recording was normalized to constant frame rate and fully decoded successfully. The original saved account was restored and the temporary test account removed. No APK or OTA was built or published, and no physical phone was tested.
