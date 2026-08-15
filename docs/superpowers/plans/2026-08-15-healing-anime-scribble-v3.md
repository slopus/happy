# Healing Anime Scribble v3 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the strongest approved healing anime scribble style through the existing Happy gallery preset and merge it into local `main` without losing unrelated working changes.

**Architecture:** Keep the current preset registration and runtime path intact. Refine the prompt compiler and metadata in place, update localized gallery descriptions, and replace only the synthetic preview asset. Protect dirty `main` state with a recoverable stash during local integration.

**Tech Stack:** TypeScript, React Native/Expo, Vitest, Node.js registration verifier, Git worktrees.

---

## Chunk 1: Preset And Preview

### Task 1: Upgrade the prompt contract

**Files:**
- Modify: `packages/happy-app/sources/components/agents/healingScribbleSketchPrompt.ts`
- Modify: `packages/happy-app/sources/components/agents/imageStyleCatalogExtras.ts`
- Modify: `packages/happy-app/sources/components/agents/imageStylePreviewManifestExtras.ts`
- Modify: `packages/happy-app/sources/components/agents/imageAgentPrompt.test.ts`
- Modify: `.agents/skills/import-gallery-image-skill/references/integrated-cases.md`

- [ ] Export a structured immutable policy from `healingScribbleSketchPrompt.ts`: line/ink marks 80%-90%, watercolor coverage 8%-16%, quiet paper 55%-70%, identity anchors 4-6, and `textMode: 'never'`. Interpolate these policy values into the prompt so the machine contract and model instruction cannot drift.
- [ ] Replace the balanced v2 rendering with dense searching contours, a calm simplified anime face, unfinished lower contours, and the structured strong line-first policy above.
- [ ] Set `promptPath` to `garden-gpt-image-2/prompt/healing-anime-scribble-v3.md` and `sourceCaseId` to `gpt-image-2/healing-anime-scribble-v3-20260815` everywhere they are registered.
- [ ] Make v3 always text-free while preserving single input/output, original-upload continuation, privacy rules, one targeted retry, `mcp__happy__send_image`, and response rationale.
- [ ] Update `imageAgentPrompt.test.ts` to assert the exported policy object and exact v3 metadata fields. Do not assert prompt sentences or keywords; existing runtime tests continue to prove prompt composition, original-upload continuation, single-input behavior, response rationale, and image delivery instructions.
- [ ] Remove committed local paths and hashes for private user inputs/results from the ledger. Record only a de-identified acceptance conclusion.
- [ ] Verify metadata behavior with `pnpm --filter happy-app test --run sources/components/agents/imageAgentPrompt.test.ts sources/components/agents/imageStyleOptions.test.ts`; expect both files to pass without prompt-sentence assertions.

### Task 2: Update user-facing descriptions

**Files:**
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/{ca,en,es,it,ja,pl,pt,ru,zh-Hans,zh-Hant}.ts`

- [ ] Describe dense searching lines, sparse pale color, broad paper, and identity anchors in every existing translation.
- [ ] Preserve the current translation keys and style name; state that output is always text-free.
- [ ] Derive the complete language set from `packages/happy-app/sources/text/_all.ts`; expected files are `_default.ts` plus `ca`, `en`, `es`, `it`, `ja`, `pl`, `pt`, `ru`, `zh-Hans`, and `zh-Hant`.
- [ ] Use the English source meaning: `Turn one portrait into a raw healing anime construction sketch with dense searching graphite lines, a calm simplified face, sparse pale color, and broad warm-white paper.\nKeeps identity through face shape, hair, glasses, expression, pose, and one key garment or prop; always text-free.` Translate this meaning naturally in every language.

### Task 3: Replace the synthetic gallery preview

**Files:**
- Modify: `packages/happy-app/sources/assets/images/gpt-image-2/reference-examples/gpt-image-2-healing-scribble-portrait.jpg`
- Modify: `packages/happy-app/sources/components/agents/imageStylePreviewManifestExtras.ts`
- Modify: `.agents/skills/import-gallery-image-skill/references/integrated-cases.md`
- Modify: `.agents/skills/import-gallery-image-skill/scripts/verify-registration.mjs`

- [ ] Use GPT Image 2 text-to-image with a fictional bespectacled young adult and no image input; the prompt must explicitly say the subject is invented and not based on a real person.
- [ ] Normalize with `magick <generated> -resize '1448x1086^' -gravity center -extent 1448x1086 -strip <preview>` so the JPEG is exactly 1448x1086 (4:3) and EXIF/XMP/comments are removed; keep the manifest dimensions unchanged.
- [ ] Extend `verify-registration.mjs` to reject the JPEG COM marker `0xFFFE` in addition to its existing EXIF/XMP/APP13 and PNG text checks. This executable verifier is the metadata-free behavior gate.
- [ ] Record the final SHA-256 in the integration ledger.
- [ ] Run `sips -g pixelWidth -g pixelHeight <preview>` and expect `1448` by `1086`; run the registration verifier and expect no EXIF/XMP/APP13/JPEG COM/PNG text markers; run `shasum -a 256 <preview>` and copy the exact result into the ledger.
- [ ] Manually confirm the preview is fictional, text-free, line-first, sparsely colored, mostly warm-white paper, and has no scribbles crossing eyes or mouth.

## Chunk 2: Verification And Integration

### Task 4: Verify and commit the feature branch

- [ ] Run `pnpm --filter happy-app test --run sources/components/agents` and expect 15 files / 100 tests to pass.
- [ ] Run `pnpm --filter happy-app typecheck` and expect exit 0.
- [ ] Run `node .agents/skills/import-gallery-image-skill/scripts/verify-registration.mjs --style-id github-skills/gpt-image-2/1 --repository ConardLi/garden-skills --revision aaf9a82f5efd73e87cc0998edc398e75bfc35901 --template-ref skills/gpt-image-2/references/avatars-and-profile/style-transfer-selfie.md --prompt-path garden-gpt-image-2/prompt/healing-anime-scribble-v3.md --source-case gpt-image-2/healing-anime-scribble-v3-20260815 --execution-kind gpt-image-2 --input-mode image-required --multi-input single --title-key agents.imageStyleHealingScribbleSketch --hint-key agents.imageStyleHealingScribbleSketchHint --preview gpt-image-2-healing-scribble-portrait.jpg`; expect `Verified gallery Skill registration: github-skills/gpt-image-2/1`.
- [ ] Run `git diff --check`, inspect the unstaged diff, then run the following exact stage command:

  `git add .agents/skills/import-gallery-image-skill/references/integrated-cases.md .agents/skills/import-gallery-image-skill/scripts/verify-registration.mjs docs/superpowers/specs/2026-08-15-healing-anime-scribble-v3-design.md docs/superpowers/plans/2026-08-15-healing-anime-scribble-v3.md packages/happy-app/sources/assets/images/gpt-image-2/reference-examples/gpt-image-2-healing-scribble-portrait.jpg packages/happy-app/sources/components/agents/healingScribbleSketchPrompt.ts packages/happy-app/sources/components/agents/imageAgentPrompt.test.ts packages/happy-app/sources/components/agents/imageStyleCatalogExtras.ts packages/happy-app/sources/components/agents/imageStylePreviewManifestExtras.ts packages/happy-app/sources/text/_default.ts packages/happy-app/sources/text/translations/ca.ts packages/happy-app/sources/text/translations/en.ts packages/happy-app/sources/text/translations/es.ts packages/happy-app/sources/text/translations/it.ts packages/happy-app/sources/text/translations/ja.ts packages/happy-app/sources/text/translations/pl.ts packages/happy-app/sources/text/translations/pt.ts packages/happy-app/sources/text/translations/ru.ts packages/happy-app/sources/text/translations/zh-Hans.ts packages/happy-app/sources/text/translations/zh-Hant.ts`
- [ ] Run `git diff --cached --check` and expect no output. Run `git diff --cached --name-only` and require the exact staged path set above with no other files.
- [ ] Commit with `git commit -m "feat(gallery): strengthen healing anime scribble preset"` and record the resulting SHA.

### Task 5: Merge into local main without losing user work

- [ ] On `main`, record one status manifest hash with `git status --porcelain=v1 -z | shasum -a 256`; this captures XY state, paths, renames, and untracked entries without HEAD blob IDs. Record staged and unstaged content separately with `git diff --cached --binary --no-ext-diff | sed '/^index /d' | shasum -a 256` and `git diff --binary --no-ext-diff | sed '/^index /d' | shasum -a 256`. Record the untracked content manifest with `git ls-files --others --exclude-standard -z | xargs -0 shasum -a 256 | shasum -a 256`.
- [ ] Run `git stash push -u -m "codex-preserve-main-before-healing-v3"`. Save both the reflog reference `stash@{0}` and exact OID from `git rev-parse 'stash@{0}'`, then confirm `main` is clean. Do not drop this stash during merge or conflict resolution.
- [ ] From the main checkout, run `git merge --ff-only healing-sketch-portrait`. Expect `main` to point at the feature commit; if fast-forward is impossible, stop instead of creating a merge commit.
- [ ] Reapply the exact stash OID with `git stash apply --index <stash-oid>`. Resolve any overlap by retaining both the v3 gallery keys and the user's existing `abortFailedConnection` entries; never use checkout/reset to discard either side.
- [ ] Re-run the exact status, staged-diff, unstaged-diff, and untracked-content manifest commands. Require all four hashes to match their pre-stash values. Keep the stash if any comparison or conflict remains.
- [ ] With user changes restored, run the full agent tests, `pnpm --filter happy-app typecheck`, the exact v3 registration verifier, `git diff --check`, and `pnpm --filter happy-app test --run sources/sync/apiSocket.test.ts`. All must pass before dropping the stash.
- [ ] After proof of exact restoration, verify `git rev-parse 'stash@{0}'` still equals the saved OID, then run `git stash drop 'stash@{0}'`. Remove the clean merged worktree, delete the merged feature branch, and report that no push or OTA was performed.
