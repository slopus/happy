# File workspace full App fixture

From repository root:

```sh
pnpm --filter @wangjs-jacky/paws-agent build
PAWS_WORKSPACE_CODEX_BIN="$(command -v codex)" pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/file-workspace/serve.mjs
```

Starts an isolated PGlite server/account, actual Expo App, and ApiSessionClient with real workspace RPC handlers. Uses synthetic Markdown/HTML/CSS and symlink/error fixtures on disk. Does not replace production CLI/daemon or deploy externally.

Private authenticated entry: ignored `test-results/file-workspace/auth-url.txt`. Safe ports, session IDs and project root: `runtime.json`. Never share the authenticated URL or the fixture project directory publicly. Open through Ego and navigate to the first session.

Submitting an App message launches **real `codex exec`** with `gpt-6.1-sol` and `workspace-write` in the synthetic project. The fixture runner adapts messages and completion metadata; it is not the production Codex runner. Verify disk bytes and automatic file refresh separately from the final agent reply. Do not send arbitrary test chat unless you intend to launch the model. Model logs/results are ignored private artifacts.

Controller is loopback only. GET `/runtime`, `/metrics`; POST `/rpc` for the three workspace methods, `/mutate` for the Markdown file (`content`, optional `complete:true` emits a terminal event), `/mutate-dependency` changes only the fixture CSS/JS (`kind`, `content`, optional `complete:true` emits completion) without changing HTML, `/offline` ends first client. `/metrics` records real RPC calls and model execution status without storing user prompts. No business status/file polling. Transport ping only renews presence.

SIGINT/SIGTERM closes clients/model jobs and removes only this fixture environment. Actual browser steps, save/reload, dirty conflict, layout, dark theme and model completion are separate acceptance evidence; smoke.json covers only encrypted directory/read/hash/symlink checks.

Task 4 also creates an isolated synthetic machine and serves production artifact handlers over encrypted machine RPC. The store uses explicit empty fixture inventory and the real supervised `runArtifactTurn` wrapper around `codex exec`; this remains a test adapter, not the production daemon/runner. Session file handlers share that store. Machine invalidations publish the supplied durable event directly; never read the store recursively from a callback that holds its lock.

POST `/artifact-rpc` accepts the typed artifact methods against this isolated machine only. Register MD/HTML and explicitly list dependencies; compare immutable manifests before/after restoration. No business state polling or production worker replacement. When source changes are not reflected by Metro, restart only this environment's Web process with `HAPPY_E2E_WEB_NO_DEV=1` (clears cache) and reload within the same Ego task space; do not trust an old HMR render as evidence of the new source.
