# Controlled light effects

## Decision boundary

Keep aesthetic intensity and effect permission independent. `bold` never grants permission to add an effect. Ask once when the requested language or a supplied reference indicates that color and tone alone are unlikely to deliver the result.

Likely effect-bearing cues include dreamlike, soft glow, bloom, luminous, hazy, ethereal, sacred light, halation, glowing, `梦境`, `梦幻`, `柔光`, `朦胧`, `辉光`, `光晕`, `发光`, `仙气`, `神性`, and `圣洁`. Words such as bold, vivid, deep, high contrast, natural, or cinematic do not by themselves require an effect.

Treat those words as cues to assess, not automatic reasons to interrupt. If a concrete color-and-tone contract already explains the requested mood—for example pale-violet blossoms, suppressed yellow, darker surroundings, and a cold `神性` atmosphere—render the color-only preview with effects absent. Ask for diffusion permission only when the user or reference specifically needs softened highlight spread that color and tone cannot reproduce.

Use this consent question in the user's language:

> Color and tone alone may not fully create this light quality. May I add restrained source-derived highlight diffusion? It will not add a light source, object, ray, flare, or new scene content, but it can slightly soften local contrast around existing highlights.

If the user declines or does not answer, keep effects absent and explain the color-only limit. Never infer consent from an intensity choice, prior tasks, or a reference image.

## Allowed source-derived effect

Version 0.3 allows only `source_glow`:

- derive its spatial support exclusively from luminance already present in the input;
- retain the graded pixels as the base layer;
- blur only the extracted light layer, never the source image or its texture layer;
- composite the low-frequency light with bounded screen-like addition;
- keep dimensions, alpha topology, geometry, objects, faces, text, and watermark unchanged;
- record explicit consent in the recipe and effect diagnostics in the manifest.

Start with `threshold 0.55..0.75`, `knee 0.08..0.18`, `radius_fraction 0.008..0.025`, and `strength 0.05..0.16`. Use the lowest setting that makes the requested effect visible. Inspect text, faces, and hard edges at 100% before acceptance.

## Strict prohibitions

Reject synthetic or composited lighting, including:

- adding or relocating a sun, lamp, reflection, catchlight, or emissive object;
- lens flare, flare ghosts, starbursts, diffraction spikes, or artificial halos;
- god rays, volumetric beams, lightning, rim lights, or painted highlights;
- radial or directional light shapes not derived from source luminance;
- generated masks that invent illumination behind an occluder;
- arbitrary overlays, stock light assets, or generative image editing.

Do not describe `source_glow` as relighting. It only diffuses light that is already encoded in the source.

## Acceptance

Reject or revise when the effect creates a new visible edge, a detached bright patch, a synthetic shape, material clipping beyond the source or reference, or excessive loss of local contrast. A structurally safe output can still fail if the requested visual target is not reached.
