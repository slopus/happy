# File workspace history

PC Web keeps the approved chat/files shell. `VersionController` owns current artifact reads, paginated versions, an independently selected immutable preview, and durable operation IDs. `FileWorkspaceController` continues to own drafts and entry hashes. Viewing history never edits the file controller.

Registration requires an explicit entry/dependency list relative to the authorized session workspace. Only those paths are versioned. Discovery resolves the session root canonically at the machine API boundary. Managed saves use `artifactSave`; following chat references carry the artifact identity and whole-manifest expected revision in addition to the entry hash. Restoring appends a version and rebinds context only after a successful matching file read. Dirty file drafts block restore; unsent chat remains mounted.

HTML and Markdown previews share immutable `readRef` resource access. Missing historical files never fall back to working paths. HTML keeps its existing static sandbox and explicit interaction switch. Read-only Markdown defaults to inert images/cards; only a caller-supplied frozen image map opts images in. Closing/replacing a read revokes its object URLs.

Mutations never retry automatically. Unknown results retain scoped operation IDs across reload; a user status check can inspect the operation and explicitly resolve advertised recovery actions against the observed revision. Machine events, reconnect and user actions refresh once; there are no periodic business queries.

Focused checks: `pnpm exec vitest run sources/components/fileWorkspace sources/components/markdown sources/sync/artifactWorkspace.test.ts`, `pnpm typecheck`, `pnpm export:web`. The isolated integration fixture is documented under `e2e/fixtures/file-workspace/README.md`.
