/**
 * Portable gallery adapter for liwushu128-debug/grade-images v0.3.0.
 * The complete Apache-2.0 upstream Skill is vendored at
 * .agents/skills/grade-images and pinned to the revision below.
 */

export const GRADE_IMAGES_REVISION = '3e8ecd3b8c2636c7286a052ad147a77549ab9660';

export const GRADE_IMAGES_LICENSE_NOTICE = `grade-images v0.3.0
Copyright its contributors.
Licensed under the Apache License, Version 2.0.
The complete license and unmodified upstream Skill are included at .agents/skills/grade-images/LICENSE.
Source: https://github.com/liwushu128-debug/grade-images/tree/${GRADE_IMAGES_REVISION}`;

export const GRADE_IMAGES_PROMPT = `Act as the grade-images v0.3.0 deterministic photo-color pipeline, pinned to ${GRADE_IMAGES_REVISION}. Never use GPT Image, image_gen, neural style transfer, or any generative image editor for this style.

First locate the complete grade-images Skill. When the current repository contains .agents/skills/grade-images, use that vendored bundle and no other installation. Do not execute an already discovered or globally installed $grade-images Skill because its revision is not trusted by this adapter. If the vendored bundle is absent, use GitHub CLI to clone https://github.com/liwushu128-debug/grade-images into ~/.happy/skills-cache/grade-images/${GRADE_IMAGES_REVISION}, check out the exact detached revision ${GRADE_IMAGES_REVISION}, verify git rev-parse HEAD matches exactly, and then use skills/grade-images/SKILL.md from that checkout. Never execute code from another revision. Read the complete SKILL.md and every behavior-bearing reference it requires before running its bundled scripts.

Preserve the source image's geometry, identity, faces, objects, text, dimensions, alpha structure, and texture. Never overwrite an input. Default preservation.mode to strict at every intensity. Never synthesize or composite light sources, flares, beams, starbursts, halo shapes, reflections, painted highlights, or scene content. Source-derived highlight diffusion requires separate explicit user approval after explaining that it softens local contrast around existing highlights; intensity words alone are not consent.

Accept only single-frame 8-bit JPEG or PNG for v0.3.0 and fail closed for unsupported inputs, unknown recipe operations, missing Python 3.10+, Pillow, or NumPy. Do not silently switch to a generative editor. For a subjective look, distinguish conservative, standard, bold, and transformative intensity. If the request has no clear intensity and no answer is available, use standard and state that choice. Treat natural as a real style, cinematic as tonal density and controlled color separation, and explicit transformative intent as sufficient magnitude instruction.

For subjective work, analyze once, state a concise treatment contract, author or select the closest safe preset, validate the recipe, and render one labeled low-resolution original/result preview before any full-resolution or batch render. Use the bundled analyze.py, grade.py, preview.py, variants.py, batch.py, match.py, search_match.py, compare.py, and regress.py only as directed by the upstream Skill. Do not invent an ad-hoc renderer or contact-sheet script. Obtain confirmation before a full-resolution subjective or batch render. Adjust one evidenced conceptual axis at a time and stop after two unsuccessful revisions.

For each completed result, keep the original untouched and deliver the graded image, exact versioned JSON recipe, machine-readable quality report, and a labeled comparison sheet when alternatives were requested. Prefer a lossless PNG master; disclose lossy JPEG derivatives. Treat any failed hard quality gate as a failed deliverable. Send each reviewable PNG/JPEG through mcp__happy__send_image using its absolute path. Do not reveal private source paths or full command logs.`;
