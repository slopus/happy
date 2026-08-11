# Integrated gallery Skill provenance

This ledger records the immutable source and intentional adaptation boundary for gallery imports produced with this SOP. The user uploaded the screenshots in each integration task and explicitly asked for those cases to be integrated into the App gallery, which is the recorded consent for using them as references for text-free cover adaptations. Ownership beyond that task authorization was not independently verified. Original screenshots are not shipped as gallery assets; each entry records how its cover was produced and whether a separate pinned upstream source governs behavior.

## Photo–Illustration Diptych

- Style: `github-skills/photo-illustration-diptych/1`
- Source: original Happy/Paws compiler in `wangjs-jacky/happy@532e49bb711283cbe2738439039298f9cea1ef7b`; no third-party Skill code or prompt text was copied.
- Source discovery note: `ZzzLc0405/photo-abstract-editorial@82636602dcd386b38a3377df5a05a30702ad7e05` was found later through `gh` and is visually related, but the repository has no `LICENSE` file or GitHub-recognized license. Its Skill text, linked bilingual prompts, and example assets are therefore intentionally excluded. The Happy/Paws compiler remains an independent implementation derived from the four user-authorized references.
- License: MIT; complete notice in `photoIllustrationDiptychPrompt.ts`.
- Visual references explicitly supplied for this integration:
  - `/Users/jacky/.happy/attachments/2026-08-06T04-48-25-084Z-0-136591.jpg` — SHA-256 `ebee855eee975c52b3a66b771109b51fa3844ea19fff0feef67f67a3e7098a38`
  - `/Users/jacky/.happy/attachments/2026-08-06T04-48-25-089Z-1-136590.jpg` — SHA-256 `950d196e49445589320f06302d50a9d175d23f44be341b04e2bdc4572423f40e`
  - `/Users/jacky/.happy/attachments/2026-08-06T04-48-25-093Z-2-136589.jpg` — SHA-256 `a446177824e2db40ae0db53957e98ca0b40b6054c3e42f22756800d7dd22aa42`
  - `/Users/jacky/.happy/attachments/2026-08-06T04-48-25-095Z-3-136588.jpg` — SHA-256 `365fdc33e9aeac5d6950f06b9c4d3c82fed0c33e9d15459a5dc9d1f26477162f`
- Shipped text-free 4:3 cover SHA-256: `1be05966cb6631a9150626fb06c6fcce7150666efe0d5455c57962c1d8b130e9`.
- Preview relationship: the cover is an original vector harbor scene authored for this integration. It demonstrates a shared top/bottom skyline, horizon, landmark order, palette, and sailboat position while using no pixels, people, place names, or UI from the supplied screenshots. The screenshots themselves are not shipped.
- Preserved: vertical photo-above/illustration-below hierarchy; one scene expressed twice; shared semantic geometry; warm paper; subject-aware switching among ink wash, flat editorial, geometric skyline, and Art Deco; optional restrained caption treatment.
- Changed: default output is text-free unless the user supplies or requests exact copy; the gallery cover uses an original 4:3 harbor demonstration while generated task outputs default to a 3:5 poster. The shared compiler now separates canvas, panel, and source-photo ratios; requires one isotropic source scale and a shared Framing Map; and prefers paper inset space over distorted faces, bodies, circles, repeated spacing, or structural axes.
- Omitted: phone status/navigation bars, social viewer controls, progress indicators, download/play UI, original source-photo pixels, inferred place names, and any unverified third-party prompt or implementation.

## Lakeside Minimal Diptych

- Style: `github-skills/photo-illustration-diptych/2`
- Source: lakeside specialization of the original Happy/Paws compiler in `wangjs-jacky/happy@532e49bb711283cbe2738439039298f9cea1ef7b`; no third-party Skill code, prompt text, or asset was copied.
- License: MIT; complete notice in `photoIllustrationDiptychPrompt.ts`.
- User authorization: the user uploaded both references in this integration task and explicitly asked to add the result to the gallery. Ownership beyond that task authorization was not independently verified.
- Visual output reference: `/Users/jacky/.happy/attachments/2026-08-07T17-58-03-556Z-0-137505.jpg` — SHA-256 `01ce83204149de7527030defeabfb684a4b10fe8b4b989901b958a1fa6737eb4`.
- Written specification reference: `/Users/jacky/.happy/attachments/2026-08-07T17-58-03-645Z-1-137504.jpg` — SHA-256 `4379e11740be18567d86fc90ce93c8e3e461ce0b011695c674438ec2a3e43b1e`.
- Built-in image-tool source: `/Users/jacky/.codex/generated_images/019fdd5f-f182-7e03-ac57-b6c12c2d9913/exec-bff14c13-6ccd-45a2-87e8-56d4d5bd7767.png` — SHA-256 `81af6a580680f3ceeeb496e532564e196cf4dd9a72fcdc52d2dd8da8745331c8`.
- Shipped metadata-free 4:3 cover SHA-256: `4b094e1fa099e72c59403bd90a35ae51708746e3090703349e028ee0ab83d314`.
- Preview relationship: the cover is an original, text-free built-in image-tool adaptation. It demonstrates the reference's lake, boardwalk, dock, boat, shoreline, horizon, mountains, source-derived palette, and upper-photo/lower-geometry hierarchy without shipping screenshot pixels or phone/viewer UI.
- Preserved: truthful photographic upper panel; scene-map correspondence; original subject order and color atmosphere; radically simplified lower geometry; flat source-derived colors; fine lines; broad warm-ivory negative space; optional exact user-supplied typography; premium editorial restraint.
- Changed: the shared compiler gains a dedicated waterside mode that explicitly locks the path curve, dock rhythm, vessel position, shoreline, horizon, and distant landform while removing 85–95% of lower-panel detail. Its upper-photo requirement now explicitly obeys the base compiler's proportional crop or warm-paper inset instead of forcing panel fill.
- Omitted: phone status/navigation bars, social viewer controls, progress/download/play UI, screenshot pixels, automatic captions, inferred place names, gradients, decorative symbols, and unrelated stock-vector detail.

## Editorial Echo

- Style: `github-skills/photo-illustration-diptych/3`
- Source: original Happy/Paws adaptive compiler in `wangjs-jacky/happy@e8716a0a0c949f8e2b45e1e3d7c8d36ad7bba17c`; no third-party Skill code, prompt text, or preview pixels were copied.
- License: MIT; complete notice in `photoIllustrationDiptychPrompt.ts` and re-exported by `photoIllustrationEditorialEchoPrompt.ts`.
- User authorization: the user supplied the visual reference and source portrait, iterated on the result, explicitly asked to save the approved capability as a gallery style, and then explicitly requested that their portrait be used for the cover. The raw source portrait and complete derived poster remain behavior references only and are not shipped; the cover uses the approved generated watercolor likeness without original source pixels.
- Visual layout reference: `/Users/jacky/.happy/attachments/2026-08-09T11-10-26-228Z-0-138117.jpg` — SHA-256 `2fea6f852a7b4a07b5777e334353edcd3a0f7b4a637aaa33673a88c8835e909f`.
- Private source portrait: `/Users/jacky/.happy/attachments/2026-08-09T10-41-49-193Z-0-135477.jpg` — SHA-256 `26fd6215f53f78b9a6d36fe385cf28faefbc26c473eca00d8f9e2b664f4bcdbb`; not shipped.
- Approved portrait behavior reference: `/Users/jacky/.codex/generated_images/mirror-selfie-watercolor-diptych-20260809/portrait-study-v3.png` — SHA-256 `4f42d822c04a39dfdada359c0650a903d9728564186da7e1cf573ac938d8d4bf`; not shipped because it contains the private source portrait and identifiable likeness.
- Shipped metadata-free 4:3 cover SHA-256: `68824ecb87b78d1aceabb40e551a94a41601d951b841a2199462cd9cdccafbdf`.
- Preview relationship: the cover is an original HTML/CSS composition built from the approved generated watercolor likeness in `lower-watercolor.png`. It preserves the user's recognizable glasses, hair, camera, pose, and clothing while shipping no pixels from the private source photo or complete approved poster. It demonstrates one framed visual anchor, one isolated organic portrait echo, the scene-specific `THE CAMERA LOOKS BACK` title/study/caption hierarchy, thin rule, warm paper, and source-derived swatches without phone UI.
- Preserved: one-photo privacy boundary; internal Scene Map; truthful photographic anchor; source-matched semantic geometry; source-derived palette; subject-aware ink-and-watercolor interpretation; single-input behavior; anatomy, identity, and scene-correspondence quality gates; one targeted motif regeneration maximum.
- Changed: orientation now adapts among portrait 3:5, landscape 5:3, and neutral 4:3; the generated illustration becomes one isolated organic motif instead of a full second panel; a Copy Map creates one scene-specific title, indexed study label, and short caption; generation is split into a motif-only GPT Image stage and deterministic HTML/CSS typography/composition before screenshot delivery.
- Omitted: private source-photo pixels and complete approved-poster pixels; generic category titles such as PORTRAIT/TRAVEL/MEMORIES; inferred places, dates, names, brands, or biography; image-model-rendered final typography; rectangular second-image treatment; phone/status/social UI; logos, QR codes, signatures, gradients, rounded cards, and shadows.

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
- Preview source path: `/Users/jacky/.happy/attachments/2026-08-05T21-01-29-830Z-2-136444.jpg`
- Shipped text-free 4:3 cover SHA-256: `012b0398f249bd78eefbe93d11e141271d37cc7f7a9d763c778af60a49522a75`
- Preview relationship: the cover is a built-in image-tool adaptation of the user-identified output example. It removes the social viewer and typography while retaining the intended wall/tree/tower visual grammar; it is not evidence that the pinned commit generated this exact image.
- Preserved: semantic-only source use, no original pixels/tracing, proposition/tension/metaphor compiler, Standard Accent percentages, distributed-accent replacement, exact `单色块模式` trigger, one contiguous saturated field, privacy and no automatic regeneration.
- Changed: Happy sends the final image and adds the requested creative idea/art-direction disclosure through additive response instructions.
- Omitted: no behavior-bearing rule; private local paths and full prompt disclosure remain suppressed by Happy.

## Deterministic Photo Grade

- Style: `github-skills/grade-images/1`
- Source: `liwushu128-debug/grade-images@3e8ecd3b8c2636c7286a052ad147a77549ab9660`
- License: Apache-2.0; complete unmodified license and Skill bundle in `.agents/skills/grade-images/`
- Preview source path: `/Users/jacky/.happy/attachments/2026-08-05T21-16-30-341Z-0-136454.jpg`
- Shipped text-free 4:3 cover SHA-256: `41c31d0d54567cfd80d0e743e29a736d4d7cd1c420827def7617e992f2033ccc`
- Preview relationship: the cover is a built-in image-tool adaptation of the user-identified v0.3.0 before/after example. It isolates a single clean graded lake view and removes comparison/UI text; it is not evidence that the vendored revision generated this exact image.
- Preserved: complete scripts, recipes, linked references, strict preservation, non-generative execution, supported formats/dependencies, intensity semantics, separate source-glow consent, preview-first flow, quality gates, recipes/reports/output contract.
- Changed: `executionKind=deterministic-grade` routes away from GPT Image; a pinned GitHub cache fallback makes the exact Skill available outside this repository.
- Omitted: no processing behavior. Happy owns inline media delivery and private-path secrecy.

## Gathered Scenes Zine

- Style: `github-skills/scenes-gathered-zine/1`
- Source: `Zeejay0/gathered-scenes-zine-skill@e764b7fd243d7cc501723b9d325279bf6dd852c2`
- License: MIT; complete notice in `scenesGatheredZinePrompt.ts`
- Preview source path: `/Users/jacky/.happy/attachments/2026-08-05T21-26-30-354Z-0-136458.jpg`
- Shipped text-free 4:3 cover SHA-256: `6e36a235ff993d1a86b30491c8d0b9a38169a9930d315c9951a5e2b50a635772`
- Sea variant source path: `/Users/jacky/.happy/attachments/2026-08-05T21-36-36-805Z-0-136466.jpg`
- Sea variant shipped text-free 4:3 cover SHA-256: `fdac12930c9d55fc67d56091311e9e4cd517f33639bd04f3fa3c90dbdf163e8e`
- Preview relationship: both covers are built-in image-tool adaptations of the user-identified output examples. They remove the social viewer and typography, extend the collage edge to edge, and retain the requested mountain/coastal visual grammar; they are not evidence that the pinned commit generated these exact images.
- Preserved: truthful photo anchor, Scene Card, layout choices, medium abstraction, 60–80% detail removal, 85–95% organic-detail compression, illustration density/negative space, fibrous torn boundary, one structural hue and removal test, micro-text language/length rules, four-paragraph compiler, targeted one-time regeneration, privacy and output rationale.
- Changed: Happy delivers the generated file inline and composes the brief rationale with its base failure/privacy response rules.
- Omitted: no behavior-bearing rule; verbose upstream output templates are reduced to the same user-visible content.
