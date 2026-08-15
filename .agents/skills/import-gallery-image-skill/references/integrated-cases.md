# Integrated gallery Skill provenance

This ledger records public upstream revisions, shipped gallery-preview hashes, de-identified acceptance conclusions, and intentional adaptation boundaries. It intentionally excludes local paths, non-shipped input or result hashes, and likeness descriptions.

## Photo–Illustration Diptych

- Style: `github-skills/photo-illustration-diptych/1`
- Source: original Happy/Paws compiler in `wangjs-jacky/happy@532e49bb711283cbe2738439039298f9cea1ef7b`; no third-party Skill code or prompt text was copied.
- Source discovery note: `ZzzLc0405/photo-abstract-editorial@82636602dcd386b38a3377df5a05a30702ad7e05` was found later through `gh` and is visually related, but the repository has no `LICENSE` file or GitHub-recognized license. Its Skill text, linked bilingual prompts, and example assets are therefore intentionally excluded. The Happy/Paws compiler remains an independent implementation derived from an approved reference set.
- License: MIT; complete notice in `photoIllustrationDiptychPrompt.ts`.
- De-identified acceptance: the reference set approved the shared photo-to-illustration composition and adaptive rendering behavior. Non-shipped review inputs and results are not identified in this repository.
- Shipped text-free 4:3 cover SHA-256: `1be05966cb6631a9150626fb06c6fcce7150666efe0d5455c57962c1d8b130e9`.
- Preview relationship: the cover is an original vector harbor scene authored for this integration. It demonstrates a shared top/bottom skyline, horizon, landmark order, palette, and sailboat position while using no pixels, people, place names, or UI from non-shipped references.
- Preserved: vertical photo-above/illustration-below hierarchy; one scene expressed twice; shared semantic geometry; warm paper; subject-aware switching among ink wash, flat editorial, geometric skyline, and Art Deco; optional restrained caption treatment.
- Changed: default output is text-free unless the user supplies or requests exact copy; the gallery cover uses an original 4:3 harbor demonstration while generated task outputs default to a 3:5 poster. The shared compiler now separates canvas, panel, and source-photo ratios; requires one isotropic source scale and a shared Framing Map; and prefers paper inset space over distorted faces, bodies, circles, repeated spacing, or structural axes.
- Omitted: phone status/navigation bars, social viewer controls, progress indicators, download/play UI, original source-photo pixels, inferred place names, and any unverified third-party prompt or implementation.

## Lakeside Minimal Diptych

- Style: `github-skills/photo-illustration-diptych/2`
- Source: lakeside specialization of the original Happy/Paws compiler in `wangjs-jacky/happy@532e49bb711283cbe2738439039298f9cea1ef7b`; no third-party Skill code, prompt text, or asset was copied.
- License: MIT; complete notice in `photoIllustrationDiptychPrompt.ts`.
- De-identified acceptance: the reviewed waterside example approved the specialized composition and simplification behavior. Non-shipped review inputs and results are not identified in this repository.
- Shipped metadata-free 4:3 cover SHA-256: `4b094e1fa099e72c59403bd90a35ae51708746e3090703349e028ee0ab83d314`.
- Preview relationship: the cover is an original, text-free built-in image-tool adaptation. It demonstrates the reference's lake, boardwalk, dock, boat, shoreline, horizon, mountains, source-derived palette, and upper-photo/lower-geometry hierarchy without shipping screenshot pixels or phone/viewer UI.
- Preserved: truthful photographic upper panel; scene-map correspondence; original subject order and color atmosphere; radically simplified lower geometry; flat source-derived colors; fine lines; broad warm-ivory negative space; optional exact user-supplied typography; premium editorial restraint.
- Changed: the shared compiler gains a dedicated waterside mode that explicitly locks the path curve, dock rhythm, vessel position, shoreline, horizon, and distant landform while removing 85–95% of lower-panel detail. Its upper-photo requirement now explicitly obeys the base compiler's proportional crop or warm-paper inset instead of forcing panel fill.
- Omitted: phone status/navigation bars, social viewer controls, progress/download/play UI, screenshot pixels, automatic captions, inferred place names, gradients, decorative symbols, and unrelated stock-vector detail.

## Editorial Echo

- Style: `github-skills/photo-illustration-diptych/3`
- Source: original Happy/Paws adaptive compiler in `wangjs-jacky/happy@e8716a0a0c949f8e2b45e1e3d7c8d36ad7bba17c`; no third-party Skill code, prompt text, or preview pixels were copied.
- License: MIT; complete notice in `photoIllustrationDiptychPrompt.ts` and re-exported by `photoIllustrationEditorialEchoPrompt.ts`.
- De-identified acceptance: iterative review approved the adaptive editorial composition and isolated watercolor-motif behavior. Non-shipped review inputs and results are not identified in this repository.
- Shipped metadata-free 4:3 cover SHA-256: `68824ecb87b78d1aceabb40e551a94a41601d951b841a2199462cd9cdccafbdf`.
- Preview relationship: the cover is a deterministic HTML/CSS composition built from an approved non-shipped watercolor motif. It demonstrates one framed visual anchor, one isolated organic portrait echo, scene-specific title/study/caption hierarchy, a thin rule, warm paper, and source-derived swatches without phone UI.
- Preserved: one-photo privacy boundary; internal Scene Map; truthful photographic anchor; source-matched semantic geometry; source-derived palette; subject-aware ink-and-watercolor interpretation; single-input behavior; anatomy, identity, and scene-correspondence quality gates; one targeted motif regeneration maximum.
- Changed: orientation now adapts among portrait 3:5, landscape 5:3, and neutral 4:3; the generated illustration becomes one isolated organic motif instead of a full second panel; a Copy Map creates one scene-specific title, indexed study label, and short caption; generation is split into a motif-only GPT Image stage and deterministic HTML/CSS typography/composition before screenshot delivery.
- Omitted: non-shipped source and approval artifacts; generic category titles such as PORTRAIT/TRAVEL/MEMORIES; inferred places, dates, names, brands, or biography; image-model-rendered final typography; rectangular second-image treatment; phone/status/social UI; logos, QR codes, signatures, gradients, rounded cards, and shadows.

## Minimal Zine Paper Poster

- Style: `github-skills/minimal-zine-poster/1`
- Source: `LiamGvchi/gc-minimal-zine-poster@4cb0396ad4e834019f753b37e1c4f415f5e02026`
- License: MIT; complete notice in `gcMinimalZinePosterPrompt.ts`
- Preview source: upstream `examples/pause-map.jpeg`; the shipped `gc-minimal-zine-poster-pause-map.jpg` is a user-requested, text-free 4:3 cover adaptation generated with the built-in image tool from that source.
- Shipped cover SHA-256: `6682dca04105bf98d8f06beedc041e621d910218423e2fedf1fd7e6025da194e`
- Preserved: Standard Mode composition, 70–90% paper space, material texture, type hierarchy, single high-chroma hue, anti-repetition variation recipe, hard avoids.
- Changed: upstream delivery Markdown becomes Happy `send_image` plus batch/continuation contract.
- Omitted: no behavior-bearing rule; upstream file-system presentation details are handled by Happy.

## Scene Distillation Zine

- Style: `github-skills/scene-distillation-zine/1`
- Source: `Zeejay0/scene-distillation-zine-v1-3@921390baac518c85d60a6d98709f1dd657eec720`
- License: MIT; complete notice in `sceneDistillationZinePrompt.ts`
- De-identified acceptance: visual review approved the wall, tree, and tower distillation grammar. Non-shipped review inputs and results are not identified in this repository.
- Shipped text-free 4:3 cover SHA-256: `012b0398f249bd78eefbe93d11e141271d37cc7f7a9d763c778af60a49522a75`
- Preview relationship: the cover is a built-in image-tool adaptation of an approved output example. It removes the social viewer and typography while retaining the intended wall/tree/tower visual grammar; it is not evidence that the pinned commit generated this exact image.
- Preserved: semantic-only source use, no original pixels/tracing, proposition/tension/metaphor compiler, Standard Accent percentages, distributed-accent replacement, exact `单色块模式` trigger, one contiguous saturated field, privacy and no automatic regeneration.
- Changed: Happy sends the final image and adds the requested creative idea/art-direction disclosure through additive response instructions.
- Omitted: no behavior-bearing rule; non-shipped review artifacts and full prompt disclosure remain suppressed by Happy.

## Deterministic Photo Grade

- Style: `github-skills/grade-images/1`
- Source: `liwushu128-debug/grade-images@3e8ecd3b8c2636c7286a052ad147a77549ab9660`
- License: Apache-2.0; complete unmodified license and Skill bundle in `.agents/skills/grade-images/`
- De-identified acceptance: visual review approved the isolated graded-lake demonstration. Non-shipped review inputs and results are not identified in this repository.
- Shipped text-free 4:3 cover SHA-256: `41c31d0d54567cfd80d0e743e29a736d4d7cd1c420827def7617e992f2033ccc`
- Preview relationship: the cover is a built-in image-tool adaptation of an approved v0.3.0 before/after example. It isolates a single clean graded lake view and removes comparison/UI text; it is not evidence that the vendored revision generated this exact image.
- Preserved: complete scripts, recipes, linked references, strict preservation, non-generative execution, supported formats/dependencies, intensity semantics, separate source-glow consent, preview-first flow, quality gates, recipes/reports/output contract.
- Changed: `executionKind=deterministic-grade` routes away from GPT Image; a pinned GitHub cache fallback makes the exact Skill available outside this repository.
- Omitted: no processing behavior. Happy owns inline media delivery and non-shipped artifact secrecy.

## Gathered Scenes Zine

- Style: `github-skills/scenes-gathered-zine/1`
- Source: `Zeejay0/gathered-scenes-zine-skill@e764b7fd243d7cc501723b9d325279bf6dd852c2`
- License: MIT; complete notice in `scenesGatheredZinePrompt.ts`
- De-identified acceptance: visual review approved both mountain and coastal collage variants. Non-shipped review inputs and results are not identified in this repository.
- Shipped text-free 4:3 cover SHA-256: `6e36a235ff993d1a86b30491c8d0b9a38169a9930d315c9951a5e2b50a635772`
- Sea variant shipped text-free 4:3 cover SHA-256: `fdac12930c9d55fc67d56091311e9e4cd517f33639bd04f3fa3c90dbdf163e8e`
- Preview relationship: both covers are built-in image-tool adaptations of approved output examples. They remove the social viewer and typography, extend the collage edge to edge, and retain the requested mountain/coastal visual grammar; they are not evidence that the pinned commit generated these exact images.
- Preserved: truthful photo anchor, Scene Card, layout choices, medium abstraction, 60–80% detail removal, 85–95% organic-detail compression, illustration density/negative space, fibrous torn boundary, one structural hue and removal test, micro-text language/length rules, four-paragraph compiler, targeted one-time regeneration, privacy and output rationale.
- Changed: Happy delivers the generated file inline and composes the brief rationale with its base failure/privacy response rules.
- Omitted: no behavior-bearing rule; verbose upstream output templates are reduced to the same user-visible content.

## Healing Scribble Sketch

- Style: `github-skills/gpt-image-2/1`
- Source: `ConardLi/garden-skills@aaf9a82f5efd73e87cc0998edc398e75bfc35901`
- Upstream template: `skills/gpt-image-2/references/avatars-and-profile/style-transfer-selfie.md`
- License: MIT; complete notice in `healingScribbleSketchPrompt.ts`.
- De-identified acceptance: representative portrait checks approved the latest high-intensity abstraction. Non-shipped review inputs and results are not retained or identified in this repository.
- Shipped metadata-free 4:3 cover SHA-256: `70a3c534832532faed62cb80816df56002382cb661b51d2077d7eab429760daf`.
- Preview relationship: the cover is a text-only GPT Image 2 generation of a fictional young adult with glasses, explicitly not based on a real person. It demonstrates a calm simplified anime face, dense searching graphite and black-ink contours around hair and clothing, an unfinished lower silhouette, sparse pale color, broad warm-white paper, and no text, logo, watermark, interface, or photographic source pixels.
- Preserved: one-photo input; original-upload continuation; private source handling; recognizable identity through 4-6 face, hair, glasses, expression, pose, garment, or prop anchors; single-image output; source-derived pale palette; at most one targeted retry; `mcp__happy__send_image` delivery; concise localized result rationale.
- Changed: v3 fixes 80%-90% of visible marks as graphite or black ink, 8%-16% pale-color coverage, 55%-70% warm-white paper, dense searching contours around hair, clothing, accessories, and the outer silhouette, protected eyes and mouth, and a deliberately unfinished lower contour.
- Omitted: all captions and optional handwriting; user-upload paths, hashes, portrait descriptions, and private test outputs; source pixels; complete scenery; realistic skin, eyes, lips, teeth, and camera rendering; viewer UI, logos, watermarks, and pseudo-text.
- Adaptation parity ledger:
  - Upstream identity-preserving style transfer -> Character Map plus explicit human identity and non-human structure gates.
  - Approved strong abstraction -> searching contours, broken strokes, overlapping corrections, unfinished lower edges, and protected critical facial geometry.
  - Sparse color treatment -> 2-4 source-derived quiet colors, translucent blooms, dry-brush skips, detached flecks, and substantial untouched warm-white paper.
  - Happy delivery contract -> image-required single-input generation, original-upload continuation, one targeted correction maximum, localized rationale, and `mcp__happy__send_image` delivery.
