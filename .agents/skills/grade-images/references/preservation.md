# Preservation contract

## Purpose

Treat preservation as an engine constraint, not a prompt preference. Color grading necessarily changes pixel values; strict preservation means retaining spatial structure, identity, objects, and the source texture field.

## Strict-mode whitelist

Allow only:

- ICC conversion and output profile assignment;
- exposure gain;
- global RGB white-balance gains;
- black and white point mapping;
- monotonic luminance curves and highlight roll-off;
- ASC-CDL-style slope, offset, power, and saturation;
- global saturation adjustment;
- low-strength split toning;
- smoothly feathered hue-range remapping selected only from source-pixel hue, saturation, and luminance values;
- smoothly feathered protection masks that only reduce a grade.
- explicitly approved source-derived highlight diffusion that blurs only an extracted light layer and composites it back without replacing source pixels.

## Forbidden operations

Reject any recipe requesting:

- crop, resize, rotate, warp, perspective, or liquify;
- inpainting, outpainting, object replacement, or generative editing;
- face restoration, beauty filters, skin smoothing, or reshaping;
- blur, sharpen, denoise, clarity, texture, dehaze, or local-contrast enhancement;
- grain, dust, scratches, arbitrary blur, synthetic bloom, synthetic glow, or other texture synthesis;
- added suns, lamps, reflections, catchlights, lens flares, flare ghosts, starbursts, halos, rays, volumetric beams, rim lights, or painted highlights;
- an unknown operation or arbitrary executable filter string.

Do not add a forbidden operation merely because a named style commonly includes it. A film look may reproduce its tone and color response without adding grain.

`source_glow` is not relighting. It may only spread low-frequency light from highlights already encoded in the input, requires explicit user consent, and must leave the unblurred graded image as the base layer. It may slightly reduce apparent local contrast around those highlights; disclose that before consent.

## Masks

Use masks only to reduce a color transform in protected regions. Never use a mask to synthesize, heal, sharpen, blur, or reshape content. Feather masks enough to avoid new visible boundaries. When mask confidence is low, disable or reduce the uncertain mask and review the global grade visually; do not automatically weaken the whole image.

Schema 1.2 hue ranges are color selections, not semantic masks. They may remap every source pixel meeting explicit hue, saturation, and luminance gates, but they cannot claim to identify a flower, garment, sky, face, or object. Use broad feathers and disclose when visually similar source colors may move together. A recipe requesting a semantic or generated mask must fail closed.

The v0.2 skin mask is a feathered color heuristic, not face parsing. It can include wood, earth, or a globally warm scene. Treat coverage above 35% as uncertain, inspect the preview, and reduce or disable protection when it is overbroad. Preserve actual skin through globally safe color choices when the mask is unusable. Do not claim semantic face detection.

## Encoding

Decode the source once, process in floating point, and encode once. Prefer a lossless PNG master. A newly encoded JPEG cannot be pixel-identical to the source; label it as a lossy derivative and use high quality with minimal chroma subsampling.

## Honest limits

Do not describe tone compression as recovered detail. Fully clipped encoded pixels contain no recoverable scene information. RAW support may later expose sensor detail that is absent from an encoded JPEG, but v0.3 does not process RAW.
