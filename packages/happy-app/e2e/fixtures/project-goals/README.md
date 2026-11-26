# Project Goal workspace acceptance

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/project-goals/serve.mjs
```

Uses the complete App, isolated PGlite account, actual encrypted machine/session RPC, strict project parser, archive files, production HTTP submission/history adapter, persistent execution receipts, file chunks and version approval. The session **launcher is a stub** that creates real relay sessions; it never launches a daemon/model or runs real project work. This fixture does not prove production worker startup.

Ignored `happy-app/test-results/project-goals/runtime.json` contains safe local runtime paths. `auth-url.txt` is a private authenticated URL; never publish it or log its contents. Open it with Ego, then use the project's rail entry. Only synthetic local data is written. No tunnel or production daemon changes.

Cases: P1 project/feature isolation and direct projects; P2 details/files and common middle workspace; P3 empty chats, history and HTML/Markdown continuity; P4 one accepted submission across retry/reload and a lost response; P5 accept exact file bytes then invalidate after update; P6 AI authoring opens an unsent draft and new-project events refresh the catalog; P7 native skin/theme surfaces.

Loopback controller has GET `/runtime`, `/metrics`; POST `/rpc`, `/mutate-final`, `/directory-error`, `/lose-submission-response`, `/add-project`, `/shutdown`. The latter closes only this isolated environment. There is no business polling. Presence is renewed only by transport ping events.

## Canvas media performance

From the workspace root, build the frame and start a new fixture.

```sh
pnpm --filter happy-app build:project-canvas
PAWS_CANVAS_TEST_RUN=media-perf pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/project-goals/serve.mjs --canvas-perf
```

The project contains 29 generated PNGs. The first three have no thumbnail, so their originals take multiple 64 KiB ranges. The remaining 26 have JPEG previews. The test relay delays original range replies by 700 ms and records method, offset, duration, and byte count in `/metrics.canvasReads`. Use the private auth URL file to open the project in Ego. Record the controller timestamp before opening the canvas to compare a fresh run. Inspect whether available previews complete during legacy original reads and whether any one original exceeds four simultaneous ranges. The fixture does not start a model worker.

For the RPC check alone, append `--rpc-only` to the fixture command and skip the frame build. In another terminal from `packages/happy-app`, run the actual Web canvas client against the isolated relay.

```sh
PAWS_CANVAS_PERF_RUNTIME="$PWD/test-results/project-canvas-media-perf/runtime.json" \
  pnpm exec vitest run --config e2e/fixtures/project-goals/canvasPerfRpc.config.mjs
```

This check verifies the 29-item snapshot, a full original hash, the preview hash, and the four-way range limit. Use a separate fixture for concurrent browser and RPC verification so they do not share metrics.

Latest interaction contract: the card body selects its Task and details. Its chat action directly opens the newest verified conversation, including on an unselected card; only an empty history creates one blank conversation. Explicit new chat remains in the history menu. Repeated opens create no duplicates; task switching preserves drafts and the details-header task switcher. Project cards use the bundled V2.2 covers.

`verify-task-flow.ego.mjs` covers card chat reuse/creation, draft continuity, delivery agreement persistence and validation, batch draft isolation, goal-wide read-only files, cached-directory failure recovery, and the rail list entry. Run it only through Ego against a fresh fixture and its explicitly recorded task space/target. See `docs/validation/project-task-flow.md` for the config and boundaries. It creates one blank synthetic conversation and edits a synthetic task index; it never submits model instructions.

Current desktop conversation layout: retain the original card gallery on the left, narrowing it when the conversation/document opens between cards and details. The center switches between chat and document; the right panel switches between details and the requested file tree. Explicit file maximization is reversible. `verify-conversation-layout.ego.mjs` covers eight layout/history/draft/card cases with eight synthetic cards. See `docs/validation/project-visible-cards.md`.


`verify-pinned-items.ego.mjs` / `verify-pinned-layout.ego.mjs` cover the homepage favorite shelf, child-project actions, scope/task document organization, direct saved-file reads and responsive geometry. Use `pinnedItemsConfig={runtimePath,contextPath}` with a fresh synthetic account state; see `docs/validation/library-pinned-items.md`. Context pins one owned Ego space/target/run. No source deletion or model work is performed.


`verify-session-actions.ego.mjs` covers direct trash/archive controls, delete cancellation and automatic replacement, durable archive filtering, and reload persistence in both Task and global scope. It retires only fixture-issued synthetic sessions between passes; it never sends a model instruction. Run the ordinary cases before `record:true`; see `docs/validation/project-session-actions.md`. Capture uses the session-bound Happy helper required by the current runtime.
