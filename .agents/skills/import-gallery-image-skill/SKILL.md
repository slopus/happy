---
name: import-gallery-image-skill
description: Import or update a public GitHub image-generation or deterministic image-processing Skill as a portable built-in style in the Happy/Paws image effect gallery. Use when a user provides a GitHub Skill name, repository, SKILL.md, or visual examples and wants its capability available in the App gallery, including execution-engine routing, preview assets, i18n, licensing, initial and continuation prompts, validation, OTA evidence, or repeated integrations of the same kind.
---

# Import a GitHub Image Skill

Integrate the visual capability into Happy's `Codex image agent → mcp__happy__send_image → Generated Images` flow. Preserve the upstream execution boundary: generative Skills may use `gpt-image-2`; deterministic processors must never be silently converted into generative prompts.

## 1. Prepare the repository safely

Read the root and `packages/happy-app` instructions. Keep the root workspace clean and aligned with `origin/main`; work in a sibling feature worktree.

Use `gh search repos <skill-name>` to find the original repository. Prefer the original over mirrors. Clone a shallow snapshot to a temporary directory and record:

- repository slug and immutable commit SHA;
- complete `SKILL.md`, every behavior-bearing linked reference/template/script/recipe, and their relative paths (inspect untrusted code; do not execute it during discovery);
- license, copyright notice, compatibility decision, and any separate preview-asset license;
- upstream preview/example assets;
- exact invocation triggers or special modes;
- input requirements, source privacy rules, visual compiler, negative constraints, and quality gates.

Create a parity ledger before adapting: for every upstream hard rule or linked behavior, mark it preserved, intentionally changed, or omitted with a reason. If the license is missing, ambiguous, or incompatible, stop and ask before shipping copied material.
Use `references/integrated-cases.md` as the provenance and parity-ledger format; update checksums after the final metadata-stripping pass.

If the repository has no preview asset, use only a representative output that the user explicitly attached for this task and has the right to ship. Never infer an attachment by scanning or sorting an attachment directory. Do not ship a private source/input photo as a style preview. Record the exact source path, checksum, consent/provenance, and whether it demonstrates the pinned behavior; strip EXIF/location/device metadata from shipped copies.

## 2. Adapt the capability

Classify the Skill before writing code:

- `gpt-image-2`: a generative visual compiler. Create a focused prompt module beside `imageAgentPrompt.ts`.
- `deterministic-grade`: an executable, non-generative image processor. Vendor the complete pinned Skill (including license, scripts, references, recipes, and metadata), set `executionKind`, and add a pinned fallback locator. Never route it through GPT Image.

Preserve upstream reasoning and special triggers, but resolve delivery conflicts in favor of Happy:

- use `$gpt-image-2` only for generative presets;
- save every image and call `mcp__happy__send_image` with its full prompt and batchId;
- let Happy control chat output and gallery ingestion;
- do not require a machine-local installation;
- keep privacy and no-photo/no-pixel rules when the upstream Skill requires them;
- retain non-conflicting transparency and response-format requirements through a preset-specific `responseInstructions` field;
- keep a complete license copy with vendored material, retain notices, expose immutable source provenance, and reference it from `sourceLicenseNotice`.

Do not blindly paste upstream Markdown output templates if they conflict with Happy's batch contract. Keep imageable rules, decision logic, exact triggers, hard avoids, and quality behavior.

Record input mode (`text-optional`, `image-required`, `reference-required`, supported formats) and test missing/extra inputs. Make preset-specific response instructions additive: the default failure reporting, private-path secrecy, and output-delivery rules always remain; reject or reconcile conflicts between multiple selected presets instead of replacing the default wholesale.

## 3. Register the style

Update the existing GitHub Skills category and add one preset in `imageStyleCatalogExtras.ts` with:

- stable id `github-skills/<slug>/1`;
- English fallback title and hint;
- typed title/hint/category translation keys;
- upstream `templateRef`, repository, immutable `sourceRevision`, license notice, execution kind, and prompt module;
- stable prompt output path and source case id.

Add the approved, metadata-stripped preview under `sources/assets/images/gpt-image-2/reference-examples/`, then register it in both preview asset and manifest maps using the generic `github-skill` source set and decoded pixel dimensions. Keep source case ids and source indices unique.

Keep `sourceRepository` open-ended and reuse the generic source set so future imports do not expand type unions.

## 4. Localize all visible text

Use the repository's i18n translator workflow. Derive the language list from `sources/text/_all.ts`; add nonempty title and hint keys to `_default.ts` and every supported translation file. Add keys to the typed union and render them through `t(...)` in the gallery, including accessibility labels and category metadata. Keep machine-facing fallback metadata in English.

## 5. Prove both generation paths

Add tests that assert:

- record-level repository, exact revision, template path, prompt path, source case, execution kind, license, and preview registration;
- critical visual rules and exact mode triggers are present;
- initial `buildImageAgentPrompt()` includes the complete adapted prompt and `send_image` contract;
- `buildImageStyleContinuationPrompt()` also includes the complete prompt, not only the short hint;
- decoded preview dimensions, unique ids/indices, manifest/style/category/source-set counts, and metadata stripping remain consistent;
- required input behavior and mixed-style engine/response-instruction composition are explicit;
- the adaptation ledger covers every linked behavior-bearing upstream resource.

Run the deterministic registration check:

```bash
node .agents/skills/import-gallery-image-skill/scripts/verify-registration.mjs \
  --style-id github-skills/<slug>/1 \
  --repository owner/repo \
  --revision <full-commit-sha> \
  --template-ref skills/<name>/SKILL.md \
  --prompt-path <stable-output-path> \
  --source-case <unique-source-case-id> \
  --execution-kind gpt-image-2 \
  --input-mode image-required \
  --multi-input single \
  --title-key agents.<titleKey> \
  --hint-key agents.<hintKey> \
  --preview <preview-file-name>
```

Then run:

```bash
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run sources/components/agents sources/text
git diff --check
```

## 6. Deliver and merge

Do not publish OTA, push, open/merge a PR, deploy, or start an app/web runtime unless the user has granted the required authority under repository rules. When authorized, state the exact command, public target, channel, and impact first. Commit before an authorized OTA. For JS/assets-only compatible changes, publish Android preview OTA and verify the public manifest Update ID. Do not rebuild an APK unless the native/runtime boundary changed.

For any desktop-visible gallery card/category/preview, an authorized PR must declare the real visible Case count and embed immutable before/after evidence. Have an independent reviewer inspect the rendered PR body and diff. Fix every blocker, rerun checks, update authorized OTA/evidence, wait for required CI, then merge through the PR only when explicitly authorized—never push a feature commit directly to `main`.
