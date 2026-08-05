---
name: grade-images
description: Analyze, correct, match, and batch color-grade JPEG and PNG photographs with a deterministic, non-generative pipeline, plus explicitly approved source-derived highlight diffusion. Use whenever the user asks to color grade, color correct, fix exposure or white balance, match a reference image, create a cinematic, vivid, dreamy, soft-glow, or film-like look, make a photo set cohesive, or apply reproducible image treatment without changing geometry, identity, facial features, objects, text, or scene content.
---

# Grade Images

Create reproducible photo color grades while preserving spatial structure, identity, and texture. Let visual reasoning choose intent and parameters; let the bundled deterministic renderer change pixels.

## Non-negotiable defaults

- Never overwrite an input image.
- Default to `preservation.mode: strict`.
- Keep preservation strict at every aesthetic intensity. Do not confuse structural safety with a weak color grade.
- Never use a generative image editor for a color-only request.
- Never synthesize or composite a light source, flare, beam, starburst, halo shape, reflection, or painted highlight.
- Treat aesthetic intensity and effect permission as independent. `bold` or `transformative` is not consent for an effect.
- Keep controlled effects absent unless the user explicitly approves source-derived highlight diffusion after being told that it can soften local contrast around existing highlights.
- Never claim to recover detail that is clipped in an encoded JPEG or PNG.
- Render a low-resolution preview before a full batch when the requested look is subjective.
- Save the exact recipe beside every final result.
- Fail closed when a recipe contains an unknown or texture-changing operation.

Read [preservation.md](references/preservation.md) before rendering. Read [recipe-schema.md](references/recipe-schema.md) before authoring or modifying a recipe. Read [intensity-strategies.md](references/intensity-strategies.md) before interpreting a subjective look or strength request. Read [controlled-light-effects.md](references/controlled-light-effects.md) whenever the prompt or reference may require glow, diffusion, haze, dreaminess, sacred light, or another optical-light quality. Read [quality-gates.md](references/quality-gates.md) before accepting final outputs. Read [testing.md](references/testing.md) before creating multi-variant previews or regression cases. For color decisions and parameter interpretation, read [color-science.md](references/color-science.md).

## Choose a mode

- `audit`: inspect files and report technical characteristics without changing them.
- `correct`: correct exposure, white balance, clipping risk, and tonal balance without adding an aesthetic look.
- `look`: apply a described creative color treatment after technical correction.
- `match`: derive a safe color treatment from a reference image without neural style transfer.
- `batch`: normalize each source independently, then apply one shared creative look.
- `variants`: render two or more independently authored alternatives and a labeled comparison sheet.

Do not treat identical parameters as perceptual consistency. For a batch, keep per-image correction separate from the shared look.

## Preflight

1. Locate the skill directory and use its bundled scripts by absolute path.
2. Require Python 3.10+, Pillow, and NumPy. If unavailable, stop and report the missing dependency; do not silently switch to a generative editor.
3. Accept single-frame, 8-bit JPEG and PNG in v0.3.0. Reject animation and higher-bit-depth inputs instead of silently losing frames or precision. Preserve dimensions and alpha structure. Convert a valid embedded ICC profile to the sRGB working/output space; preserve supported EXIF data when requested. Record a warning when an embedded profile is invalid or an untagged CMYK JPEG requires an uncertain default conversion.
4. Determine whether the user supplied a reference image, a named look, or only a correction request. Separately determine aesthetic intensity: `conservative`, `standard`, `bold`, or `transformative`.
5. For a subjective look with no clear intensity cue, ask the user to choose conservative, standard, bold, or transformative. If no answer is available and continuing is appropriate, use standard and state that choice. Never silently default a subjective look to conservative.
6. Separately decide whether color and tone can satisfy the request. If controlled diffusion may be needed, ask for effect permission; never infer it from intensity or prior tasks.
7. Before a subjective render, state a concise treatment contract: magnitude, tonal and color axes, direction, scope, must-be-obvious outcome, protected exceptions, and effect status. Use this to expose misunderstandings; do not request confirmation unless a choice or effect permission is genuinely needed.

## Interpret intent

- Treat preservation and aesthetic intensity as independent controls. Keep geometry, identity, facial features, objects, and texture protected even for a bold or transformative grade.
- Treat `natural` as a style, not a synonym for low saturation or low intensity. Preserve vivid signature colors unless the preview shows clipping, hue breakage, or fluorescence.
- Treat `cinematic` as tonal density and controlled color separation, not automatic fading or desaturation.
- Map `保守`, `轻微`, `微调`, `克制`, `subtle`, or `restrained` to conservative. Map `放开调`, `强烈`, `浓郁`, `明显`, `大胆`, `极致`, `bold`, or `dramatic` to bold.
- Map `变革型`, `大幅改变`, `彻底改变`, `完全换一种色调`, `大幅压低黄色`, `整体明显偏紫`, `transformative`, or `radically recolor` to transformative. Explicitly choosing transformative is sufficient magnitude instruction; do not weaken it back to bold.
- Treat `梦境`, `梦幻`, `柔光`, `朦胧`, `辉光`, `光晕`, `发光`, `仙气`, `神性`, `圣洁`, and equivalent phrases as possible effect cues, not effect consent. A mood word alone does not require an effect when color and tone can satisfy the treatment contract.
- Translate object-language color requests into honest source-color ranges after visual inspection. A request such as `樱花变成浅紫色` may use schema 1.2 hue, saturation, and luminance gates, but never claim semantic flower segmentation. Disclose when visually similar source colors may move together.
- When the user changes direction, rebuild the creative look from the new intent. Do not retain incompatible assumptions from the previous recipe.

## Workflow

### 1. Analyze

Run:

```text
python scripts/analyze.py INPUT [INPUT ...] --output analysis.json
```

Use the measurements as evidence, not as an automatic aesthetic verdict. Inspect the images visually as well. Identify the subject, important skin tones, lighting conditions, likely neutral areas, and requested mood.

### 2. Author a recipe

Start from `assets/recipes/neutral-correction.json`, `natural-standard.json`, `muted-cinematic.json`, `bold-cinematic.json`, the shadow-safe `low-light-cinematic.json`, or schema 1.2 `transformative-cool-violet.json` when a major warm-to-violet change is explicitly requested. After explicit effect consent only, `soft-dream-source-glow.json` is available as a source-derived diffusion starting point. Keep technical correction, creative look, and effects separate. Record the chosen style, intensity, selection method, and effect permission, and explain subjective decisions under `intent`.

Use a preset fast path before authoring from scratch. When the user explicitly asks for a transformative warm/cream blossom or foliage scene to become pale violet, with yellow/orange suppressed, a cold restrained night mood, and no effects, copy `transformative-cool-violet.json` unchanged as the first color baseline. Do not replace it with a newly invented recipe, enable skin protection, or raise exposure merely to increase a global difference score. Render it once, inspect the result, and adjust only a visibly mismatched conceptual axis. If the prompt conflicts with the preset, author a new recipe normally.

Do not delete or neutralize a template's documented `quality_tolerances`. A nonzero near-black allowance is valid only for schema 1.2 transformative work with an explicit darker tonal hierarchy and a written reason. It changes one warning baseline only; all structural, clipping, edge, texture, effect, and content gates remain strict.

Use only one global chroma control: `look.cdl.saturation`, `look.saturation`, or schema 1.1/1.2 `look.vibrance`. Prefer vibrance when a strong look must increase muted colors without driving already-saturated colors into clipping. Stacking global chroma controls fails validation. Schema 1.2 `look.hue_ranges` may additionally remap named source color families because each range records its own bounded selection and purpose.

Validate before rendering:

```text
python scripts/grade.py validate RECIPE.json
```

Unknown fields and forbidden operations must fail validation.

For a reference image, derive a recipe at the selected strength:

```text
python scripts/match.py SOURCE REFERENCE --template assets/recipes/neutral-correction.json --strength 0.65 --output match.json [--disable-skin-protection]
```

Use approximately `0.35`, `0.65`, or `0.90` for conservative, standard, or bold. Transformative reference work may search `0.92..1.00`, then add contract-specific hue ranges when global distribution matching cannot express the requested selective change. Inspect the generated diagnostics and preview the recipe. A derived match is a starting point, not an aesthetic ground truth.

Reference matching automatically chooses vibrance instead of global saturation when muted and already-saturated regions require materially different chroma ratios. Continue iterating until `target_match` passes; do not stop merely because structural preservation passes.

For bidirectional references, inspect the generated shadow-span, highlight-span, and saturation-distribution ratios. Rich-to-soft and soft-to-rich must not collapse into similar recipes.

### 3. Render a preview

For one subjective treatment, prefer the single-pass preview command. It decodes and renders once, creates the labeled original/result sheet, writes the recipe copy and quality report, and records stage timings:

```text
python scripts/preview.py INPUT --recipe RECIPE.json --output-dir previews --max-size 1200 [--reference REFERENCE]
```

Use the lower-level renderer only when an individual image without the preview bundle is specifically needed:

```text
python scripts/grade.py render INPUT --recipe RECIPE.json --output PREVIEW.png --max-size 1600
```

Label the preview with the selected style and intensity, then show it beside the original. For subjective or batch work, obtain confirmation before full-resolution rendering. A standard preview should be clearly different at fit-to-screen size; a bold preview should be unmistakably different; a transformative preview should clearly satisfy its must-be-obvious contract even when viewed alone. A decisive localized hue-family change may satisfy transformative even when the global mean delta is modest. Never alter exposure, contrast, or unrelated colors solely to clear a global-difference threshold. If the requested axis is still weak, strengthen that axis or explain the clipping/gamut limit. Adjust one conceptual dimension at a time.

Keep preview iteration efficient. Analyze once, select or author one baseline recipe, and run `preview.py` once. Do not write an ad hoc contact-sheet script. Do not repeat render/compare cycles when the report passes and visual inspection satisfies the treatment contract. When revision is necessary, change one evidenced axis and rerun once; after two unsuccessful revisions, present alternatives or explain the limit instead of meter-chasing.

When intensity or interpretation is unresolved, render meaningful alternatives together:

```text
python scripts/variants.py INPUT --variant conservative=A.json --variant standard=B.json --variant bold=C.json --variant transformative=D.json --output-dir previews --max-size 1200
```

Show the labeled comparison sheet, retain every individual preview and recipe, and ask the user to choose a direction. When bold is already explicit, compare distinct bold treatments instead of repeating the three intensity levels.

When one reviewed base recipe defines the intended style, derive its four creative strengths automatically:

```text
python scripts/variants.py INPUT --base-recipe BASE.json --output-dir previews --max-size 1200
```

Confirm that automatic derivation left correction, protection, and effect permission unchanged.

When source glow is enabled, also label the preview `source-derived glow: approved`, inspect it at 100%, and confirm that every bright region traces back to an existing source highlight. Remove the effect if it produces a detached bright shape or obscures important text, facial features, or texture.

### 4. Render final images

```text
python scripts/grade.py render INPUT --recipe RECIPE.json --output OUTPUT.png
```

Prefer PNG for a lossless graded master. When the user needs JPEG, encode once from the original decode at quality 95 or higher. Never chain intermediate JPEG files.

For a batch, create one recipe per image containing its correction section and the same shared `look` section. Keep the recipe files with the outputs.

Generate those per-image recipes with:

```text
python scripts/batch.py INPUT [INPUT ...] --look LOOK.json --strength 0.8 --output-dir recipes [--disable-skin-protection]
```

Review `batch-manifest.json` for correction outliers before rendering. Render each image from its original file with its corresponding recipe.

Disable skin protection after visual inspection when the scene contains no people or the heuristic mask is overbroad. Keep it enabled only when the preview confirms useful coverage.

### 5. Verify

Run:

```text
python scripts/compare.py INPUT OUTPUT --recipe RECIPE.json --output report.json [--reference REFERENCE]
```

Treat a failed hard gate as a failed deliverable. Report warnings about new clipping, JPEG loss, aggressive skin shifts, or uncertain masks. Do not describe a warning as a pass.

Review the `difference` section. For standard, bold, or transformative strategies, do not accept a low-visual-delta warning merely because structural gates passed. For transformative hue-range work, a high P95 localized delta can satisfy the contract even when the global mean is modest; verify the named color family and inspect boundaries at 100%. Revise the aesthetic recipe only when the requested axis remains visibly underpowered or a documented quality problem exists.

When a reference is supplied, review `target_match` by tone, chroma, global color, and tonal-zone color. A preservation pass is not an aesthetic match. Review `recommendations`, adjust one conceptual dimension at a time, and rerun comparison. Do not reduce intentional clipping or saturation merely because it is strong when the reference contains the same characteristic within tolerance.

## Match a reference safely

Analyze source and reference separately. Match these components independently:

1. shadow, midtone, and highlight luminance distribution;
2. overall white-balance direction;
3. muted, median, and already-saturated chroma intensity;
4. shadow, midtone, and highlight color tendencies;
5. protected skin response.

Convert the comparison into an ordinary recipe and render it through the same strict engine. Do not copy pixels, synthesize content, or use neural style transfer. Expose the same conservative, standard, bold, or transformative strength choice used for other subjective looks.

For local release regression, run `python scripts/regress.py MANIFEST.json --output-dir RESULTS` with private images kept outside the repository. Require both directions to pass independently.

After the user chooses an intensity, search bounded reference strengths inside that choice:

```text
python scripts/search_match.py SOURCE REFERENCE --template TEMPLATE.json --intensity bold --output-dir match-search
```

Show all candidates and the selected result. Accept the automatic selection only when it passes structural, clipping, near-black, and saturation gates. Do not cross intensity boundaries to improve the match score.

## Output contract

For each completed task, provide:

- graded image files;
- the exact versioned JSON recipe;
- a machine-readable quality report;
- a labeled comparison sheet when alternatives were requested;
- a concise human summary of corrections, creative choices, and warnings.

Keep the original files untouched. State clearly when an output is a lossy JPEG derivative rather than the lossless master.
