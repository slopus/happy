---
name: dreamskin-theme-import
description: Add a DreamSkin theme page URL to Paws PC Web as a selectable desktop skin. Use when the user shares a dreamskin.cc/themes/ver_... link and asks to integrate or update its theme; not for unrelated theme sites.
---

# Import a DreamSkin theme into Paws

Use a sibling feature worktree; keep the root `main` clean and aligned with `origin/main` as required by `CLAUDE.md`.

Run from the worktree root:

```bash
node scripts/import-dreamskin-themes.mjs --add 'https://www.dreamskin.cc/themes/ver_<20 hex digits>'
```

`--add` accepts multiple URLs and requires `curl`, `unzip`, and `cwebp`. The importer downloads each official theme ZIP, checks package file hashes, pins the ZIP hash in `scripts/dreamskin-sources.json`, converts the background to a content-addressed WebP, and updates the generated catalog and asset manifest. It derives a stable ID from the URL. The PC theme picker reads that catalog automatically. The source CSS targets DreamSkin-specific elements, so Paws maps source colors to its own semantic tokens instead of injecting the CSS.

For a cached source ZIP, pass `--archive-dir <directory>`; ZIP filenames must be the 20-digit version suffix plus `.zip`. A full reproducibility audit is `node scripts/import-dreamskin-themes.mjs --check --archive-dir <directory>` with every registered source ZIP present. Never edit generated files by hand.

After import, inspect the source package's license and publisher, review the image composition and text contrast in the actual Paws PC Web skin, and adjust the Paws token adapter only if the package needs it. An unsupported package should fail visibly; do not silently bypass validation or inject arbitrary CSS. Run `node --test scripts/dreamskin-import-core.test.mjs`, `pnpm --filter happy-app typecheck`, the relevant Web build, and `git diff --check`. Record provenance in the PR. Follow `CLAUDE.md` for PR, merge, and deployment authorization; a pasted theme URL alone does not authorize publishing.
