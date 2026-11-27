# DSH Image Gen canvas in Paws

This workspace embeds the upstream `StudioTlCanvas` renderer in the Paws project workspace. The browser bundle directly imports the original Studio source, image landing, selection export, and theme modules. Paws owns the project data, image versions, composer, and message transport. The renderer runs on the same Paws origin in a frame with its own React 18 runtime and local tldraw assets.

- `vendor/dsh-image-gen` contains byte-for-byte upstream sources and the upstream license.
- `vendor/upstream.json` identifies the Git commit and checksums for the selected sources.
- `src/host` supplies Paws implementations for the host-bound imports. `scripts/build.mjs` checks the original import seams before bundling.
- Paws imports `src/protocol.ts` for frame events. The daemon stores the same project categories, asset versions, placements and editable scene for the Web workspace and MCP tools. Bitmap originals are stored separately from scene records. Camera and selection are local to each browser.

## Project assets and tools

The right rail can create and filter categories, select multiple images, batch-move or reclassify them, and import or export `.pawscanvas` packages. A complete export includes the editable scene. An export of selected assets includes their originals, categories and current positions. Import into an empty project restores the complete scene. Import into an existing project adds missing assets and categories while keeping its current scene and matching asset metadata.

Paws project conversations expose the `project_canvas_*` MCP tools. They can list and read originals, import workspace images, change assets and categories atomically, save edited document records, and import or export a package. The daemon resolves the project from the active conversation. A second local MCP client can read the same project by configuring this command under the same Paws account on the execution machine.

```sh
paws canvas-mcp --project "/absolute/path/to/goal-first-ops/projects/project"
```

The external connection lists assets, reads images at preview or original quality, and reads the saved scene. The project path is fixed when the connection starts. It uses the local signed-in daemon and exposes read-only tools.

The isolated build limits a project to 160 images with 12 MiB per original, a 384 KiB scene document, and a 128 MiB package. Save conflicts retain the in-progress draft in its browser tab. Shared versions protect another user's saved edits from an older write.

## Build and update

From the repository root, build the pinned source using the installed workspace dependencies.

```sh
pnpm --filter @paws/dsh-canvas upstream:check
pnpm --filter @paws/dsh-canvas build
```

The build writes `packages/happy-app/public/dsh-image-canvas/`. Its `upstream-build.json` lists the upstream modules actually bundled. Keep generated files out of Git.

To evaluate an upstream release, preview the desired tag or commit in a development worktree.

```sh
node packages/paws-dsh-canvas/scripts/sync-upstream.mjs --preview --ref v0.12.3
node packages/paws-dsh-canvas/scripts/sync-upstream.mjs --ref v0.12.3
pnpm --filter @paws/dsh-canvas build
```

Use the candidate release in place of `v0.12.3`. The preview reports the verified candidate without replacing active sources. The update copies verified Git blobs and updates the lock. Review the vendor diff and the checked host imports. If upstream pins a different tldraw version, update both `tldraw` and `@tldraw/assets` and verify its React peer range in this workspace. Verify browser reload, original image references in the native Paws composer, project layout persistence, and the isolated result callback before exposing the updated Web build.

DSH Image Gen source is Apache-2.0. The build ships the [full tldraw SDK license](licenses/tldraw-5.3.0-LICENSE.md) from the SDK's pinned version alongside the DSH license and notices. When the SDK version changes, include the verbatim license for that release in `licenses/tldraw-<version>-LICENSE.md`.

To enable the canvas on production Web, store a tldraw key that covers the HTTPS origin as `PAWS_PROJECT_CANVAS_TLDRAW_LICENSE` in the GitHub Actions `production-web` environment. The workflow checks the signature and hostname with the pinned SDK. It includes the versioned renderer only when the key passes. If an evaluation key expires, the canvas entry is unavailable and ordinary Web releases can continue. The browser runs the normal SDK license checks and displays any required watermark. Loopback development uses the unversioned local renderer without a production key.


The approved production canvas origins are exactly `https://47.115.228.20:8443`
(primary) and `https://121.43.32.242:8443` (authorized secondary). The workflow
verifies the actual key against each hostname before stamping that origin into
the runtime configuration. A key that only covers the primary keeps the primary
canvas usable and reports the secondary as blocked. Other ports, hosts and
schemes do not receive canvas configuration.

Both frames retain their Paws origin and restrictive CSP. Each server proxies
only the allowlisted versioned files to the existing OSS release, strips Paws
credentials and OSS cookies, and returns 404 for invalid or missing canvas paths.
It never redirects the iframe or its blobs to OSS. The proxy compresses large
text bundles; immutable headers permit browser reuse. The uploader also reuses
unchanged renderer files through checksum-verified OSS server-side copies across
Web revisions, and both origins use those same objects.

The secondary route is maintained by
`scripts/deploy-secondary-canvas-ingress.sh` and the production Web workflow.
It uses the existing CI deploy identity and a pinned host key. CI retains only
its derived public key for authorized provisioning if access has not yet been
installed on that host. Secondary activation and byte/MIME verification happen
after primary verification; a secondary failure fails the workflow, rolls back
its route when changed, and reports the primary result independently.
