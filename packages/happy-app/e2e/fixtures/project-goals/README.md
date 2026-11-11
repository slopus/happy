# Project Goal workspace acceptance

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/project-goals/serve.mjs
```

Uses the complete App, isolated PGlite account, actual encrypted machine/session RPC, strict project parser, archive files, production HTTP submission/history adapter, persistent execution receipts, file chunks and version approval. The session **launcher is a stub** that creates real relay sessions; it never launches a daemon/model or runs real project work. This fixture does not prove production worker startup.

Ignored `happy-app/test-results/project-goals/runtime.json` contains safe local runtime paths. `auth-url.txt` is a private authenticated URL; never publish it or log its contents. Open it with Ego, then use the project's rail entry. Only synthetic local data is written. No tunnel or production daemon changes.

Cases: P1 project/feature isolation and direct projects; P2 details/files and common middle workspace; P3 empty chats, history and HTML/Markdown continuity; P4 one accepted submission across retry/reload and a lost response; P5 accept exact file bytes then invalidate after update; P6 AI authoring opens an unsent draft and new-project events refresh the catalog; P7 native skin/theme surfaces.

Loopback controller has GET `/runtime`, `/metrics`; POST `/rpc`, `/mutate-final`, `/directory-error`, `/lose-submission-response`, `/add-project`, `/shutdown`. The latter closes only this isolated environment. There is no business polling. Presence is renewed only by transport ping events.

Latest interaction contract: entering a Task resumes its newest conversation. The primary open/continue action reuses history; explicit new chat is in the Task history menu. Verify repeated entries create zero additional conversations, a Task without history creates exactly one empty chat, drafts survive, and the composer fills the chat column before opening a file. Project cards use the bundled V2.2 covers.
