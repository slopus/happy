## Summary

- Ship the complete Paws MCP Apps stack across Session Protocol, Codex transport, replay, Web, and native hosts.
- Preserve structured MCP tool results and UI resources with bounded payloads, immutable session-local authority, lifecycle cleanup, and redacted telemetry.
- Render read-only and interactive Apps through the native adapter and a different-origin Web Proxy/opaque View sandbox.
- Mediate App tool calls, links, state updates, size changes, cancellation, approvals, and teardown through the host.
- Add a deterministic local MCP server with readiness, horizontal catalog, incident workflow, and deployment planner resources.
- Replace the Codex turn's absolute 600000ms deadline with a progress-aware inactivity timeout that pauses safely across concurrent approvals.
- Integrate the latest `main`, retaining the CLI 1.3.2 Codex/code-mode binary pairing and non-blocking Caddy deployment behavior.

This supersedes the earlier four-PR staging note: the branch now contains the complete Web + mobile implementation and its local E2E acceptance coverage.

## Visual evidence

Visible UI cases: 4

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| MCP-UI-001 · Horizontal service catalog | Apps need dense horizontal collections, filtering, selection, and a mediated action result. | ![Service catalog before](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-1-service-catalog-before.png) | ![Service catalog after](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-1-service-catalog-after.png) |
| MCP-UI-002 · Incident command workflow | Apps need filtering, expandable runbooks, and confirmed host-mediated operations. | ![Incident workflow before](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-2-incident-board-before.png) | ![Incident workflow after](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-2-incident-board-after.png) |
| MCP-UI-003 · Multi-step deployment planner | Apps need dependent configuration, pending-state locking, and a structured preview response. | ![Deployment planner before](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-3-deployment-planner-before.png) | ![Deployment planner after](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-3-deployment-planner-after.png) |
| MCP-UI-004 · Narrow mobile viewport | Complex Apps must reflow without horizontal page overflow and remain touch-usable at 430×932. | ![Mobile before](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-4-mobile-before.png) | ![Mobile after](https://raw.githubusercontent.com/wangjs-jacky/happy/707617d7db2dbe9e6673ff1f6e766997602ef9a3/docs/pr-evidence/mcp-apps/case-4-mobile-after.png) |

Visual evidence waiver: not requested

## E2E acceptance

| Case | Result | Spec / rerun | Mobile video | Report / Trace |
| --- | --- | --- | --- | --- |
| MCP-WEB-001…009 | 9/9 passed against a real Happy session, different-origin Proxy, opaque View, and local MCP server | `packages/happy-app/e2e/mcp-app-host-evidence.spec.ts` | Not requested | Four before/after groups above; authenticated traces intentionally disabled |
| MCP-NATIVE | 10/10 native adapter tests passed; Android production-mode export completed (8251 modules) | `NativeMcpAppFrameAdapter.native.test.tsx` | No physical Android device was attached | Native adapter + export evidence only |
| MCP-FIXTURE | 13/13 view-model and HTTP/stdio contract tests passed | `e2e/fixtures/mcp-app-console/vitest.config.ts` | N/A | Deterministic single-file bundle: 420,256 bytes |
| CODEX-TIMEOUT | Codex client 42/42 and resume flow 6/6 passed after merging current `main` | `codexAppServerClient.test.ts`, `resumeExistingThread.test.ts` | N/A | Progress, delayed start, and concurrent approval coverage |

- Environment and side effects: local fixture on loopback, local Happy server/Web, isolated Codex home, protected 0600 storage-state file; all temporary services stopped and temporary state moved to Trash after acceptance.
- Mobile playback: not requested; the 430×932 Web viewport was verified, while native coverage is adapter tests plus Android export because no device/emulator was attached.
- Known gaps: the earlier full App and CLI suites each hit one unrelated existing slow-test timeout under concurrent load; both slow tests passed when rerun alone. PR-scoped tests and typechecks are green.

## Validation

- [x] The declared visible Case count equals the four unique before/after screenshot groups embedded above.
- [x] Every visual Case uses comparable viewport evidence and immutable commit-SHA URLs.
- [x] Requested E2E videos use a non-local stable URL, map to a Case, and disclose mobile playback status (N/A; video was not requested).
- [ ] An independent reviewer checked the rendered PR body, not only local files or a chat report.
- [x] Independent code review passed before publication with no remaining Critical or Important findings.
- [x] Relevant automated tests passed: Web E2E 9/9, fixture 13/13, native adapter 10/10, Codex client 42/42, resume 6/6, deployment workflow 8/8, public snapshot 9/9.
- [x] `happy-app` and `happy-cli` typechecks passed after integrating current `main`.
- [ ] Every CI check triggered for the current head passed (pending GitHub Actions).
- [ ] The exact merge message was shown to and approved by the maintainer.
- [ ] The merge does not bypass branch protection.
