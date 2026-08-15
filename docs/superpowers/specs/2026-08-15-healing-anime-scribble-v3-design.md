# Healing Anime Scribble v3 Design

## Goal

Upgrade the existing `github-skills/gpt-image-2/1` gallery preset to the strongest user-approved abstraction level while keeping one stable preset ID and recognizable subject identity.

## Visual Contract

- Use graphite and black ink for roughly 80%-90% of visible marks.
- Build hair, clothing, straps, props, and outer silhouettes from repeated searching contours, broken loops, dry-brush interruptions, and unfinished construction lines.
- Keep the anime face calm and graphic: simplified eyes, tiny nose, simple mouth, and no photographic skin rendering.
- Limit translucent watercolor to roughly 8%-16% of the canvas and leave 55%-70% as untouched warm-white paper.
- Preserve recognition through 4-6 anchors such as face silhouette, glasses, hair shape, expression, pose, and one key garment or prop.
- Remove complete scenery, timestamps, clothing text, logos, pseudo-text, and retained photo pixels.
- Always produce a text-free image. v3 removes the former optional-caption behavior because the approved strong test batch used no typography.

## Product Integration

- Keep the existing preset ID, category, source repository, and single-image workflow.
- Set `promptPath` to `garden-gpt-image-2/prompt/healing-anime-scribble-v3.md` and `sourceCaseId` to `gpt-image-2/healing-anime-scribble-v3-20260815` in the preset, preview manifest, tests, and integration ledger.
- Update the gallery hint in every supported language to describe the stronger line-first result.
- Replace the preview with a metadata-free 1448x1086 (4:3) synthetic fictional portrait generated without any user-uploaded portrait. The preview must visibly show dense searching hair and garment contours, a calm anime face, sparse pale color, broad warm-white paper, and no text.
- The prompt compiler owns the visual and privacy contract. Preset registration owns the stable ID and v3 source metadata. The preview asset and manifest own the 4:3 gallery image and dimensions. Localization owns only the user-facing name and hint. The integration ledger owns de-identified provenance and the shipped preview hash.
- Keep all current runtime contracts: one uploaded image produces one illustration; continuation reuses the original upload; privacy restrictions remain; at most one targeted correction is allowed; successful results are sent with `mcp__happy__send_image`; and the response explains what was preserved, simplified, omitted, and why.
- The approved private seven-image v3 test batch is a visual benchmark only. Do not commit its paths, hashes, likeness descriptions, or generated pixels. Record only the de-identified conclusion that strong line-first behavior was accepted across close portraits and full-body sources.

## Verification

- Preserve executable registration and metadata tests without asserting natural-language prompt sentences.
- Run the full agent component test directory, Happy app typecheck, registration verifier, preview dimensions/metadata checks, and `git diff --check`.
- Perform a manual visual check against the approved behavior: graphite/ink dominates roughly 80%-90% of marks, watercolor covers roughly 8%-16%, warm-white paper covers 55%-70%, identity anchors remain recognizable, and scribbles do not cross critical facial features.
- Merge locally into `main` without pushing. Preserve the exact tracked, untracked, staged, and unstaged user state already present on `main`, including overlapping localization files.
- Re-run agent tests, app typecheck, registration/preview verification, `git diff --check`, and the restored sync test after merging and restoring the user's unrelated working changes.
