# Dual-origin canvas loading repair

Base source: e279f46dffb3862981e4f7997c6753da3acefd69. User authorized 121 canvas completion, prior image-loading bugs, publication and before/after real-flow checks on 2026-11-28. Existing primary remains 47.115.228.20:8443; 121.43.32.242:8443 is the explicitly approved secondary. No new paid service, no UI additions around the composer, no Tauri scope.

| Case | Acceptance | Before | After |
| --- | --- | --- | --- |
| C1 | Both approved origins expose a valid canvas and actual iframe/JS/CSS/font resources; unrelated origins rejected | 121 lacks button and returns SPA HTML for canvas.js | pending |
| C2 | More than16 visible previews progress while viewport remains still, bounded in-flight queue, terminal failure does not starve remaining images | fixed nearest16 stalls | pending |
| C3 | Preview save returns bounded receipt and scoped delta; no duplicate full-scene GET | ~548KB save response plus ~548KB GET | pending |
| C4 | Refresh/reopen reuses verified binary preview cache, isolated by account/machine/project/version | memory-only, repeats RPC reads | pending |
| C5 | Original bytes, geometry, scene text, selection/reference, import and save survive | existing user project126 assets | pending |
| C6 | Actual current client/host verifies first open, viewport move/zoom, refresh, reopen and new asset completion | baseline in Happy OPS previous diagnosis | pending |

Implementation split: deployment scripts/workflow; renderer visible queue; frontend persistent cache/receipt consumption; parent owns wire/CLI compact receipt and invalidation. Independent code and interaction review required. Browser only Ego through Ego OPS. Tests must be red before fixes when practical. Existing user project remains read-only for measurements; use explicitly tagged QA data for mutating cases and remove only task-owned data. Media evidence and network timing are separate runs so capture overhead does not contaminate performance results. PR screenshots require user choice per root instructions; Happy key-step frames still follow current capture protocol.

Full private diagnostic and performance baseline: Happy OPS Web diagnose-attachments local canvas-image-loading-20261127. Release/activation receipts will link from that authority; no credentials, license values, signed URLs or full business payloads in this document.

Local validation (2026-11-28): deployment scripts 99/99, CLI 86 passed plus 1 pre-existing skipped, CLI and App typechecks passed; focused App 65 passed plus the later quota regression; renderer queue/failure/bridge 12/12 and existing scene 5/5, renderer build passed. Independent review found refresh-event races, initial-scene retention and logout preview cleanup gaps; each has a regression and was corrected before publication.

Fresh live baseline on Web 7711d382: canvas JS 7,703.7 ms (628,286 encoded bytes), initial encrypted manifest 7,803.2 ms / 551,540 wire characters. Default static view decoded29 iframe images, combining fixed viewport requests and right-side list. A transient backend outage (both edges502, local3305 unavailable) occurred before this measurement; launchd recovered automatically, no service mutation was performed. Baseline excludes that outage. Exact metadata-only network record remains in the private diagnosis authority.
