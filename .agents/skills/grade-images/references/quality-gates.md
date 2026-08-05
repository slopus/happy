# Quality gates

## Hard failures

Fail the result when:

- the input path and output path resolve to the same file;
- image width, height, channel count, or alpha structure changes;
- the source file hash changes;
- recipe validation fails;
- an unknown or forbidden operation is requested;
- the output cannot be decoded or its format disagrees with the recipe;
- rendering produces non-finite pixel values.
- an enabled effect lacks explicit consent or requests anything other than source-derived glow;
- an effect creates a detached synthetic light shape or visible light with no supporting source highlight.

## Warnings

Warn when:

- output clipping increases materially;
- more than a small fraction of pixels reaches extreme saturation;
- skin protection is enabled but no reliable skin region is detected;
- a heuristic skin mask covers more than 35% of the image and may include non-skin colors;
- the grade creates strong differences at a protection-mask boundary;
- JPEG output is requested;
- metadata or ICC data cannot be preserved in the chosen format.
- a `standard`, `bold`, or `transformative` strategy produces too little visual difference for the selected intensity;
- a `conservative` strategy produces an unexpectedly large difference.
- a reference-guided output misses the intensity-specific distribution-improvement target;
- source glow excessively obscures important high-frequency detail or creates a new strong edge.

Treat low-difference warnings as intent failures, not preservation successes. A structurally safe result can still fail the user's aesthetic request.

## Structural checks

Raw SSIM is not a preservation proof because legitimate exposure and tone changes alter it. Compare structure using:

- dimensions and channel topology;
- edge-location agreement after rank-normalizing luminance;
- gradient-orientation agreement at strong source edges;
- newly introduced strong edges in formerly smooth regions;
- deterministic output hashes for repeated identical runs.

Use these metrics as alarms. The primary guarantee remains the strict operation whitelist and an engine that lacks geometry, synthesis, and texture operators.

Source glow is a bounded exception that operates only on an extracted low-frequency light layer. Inspect the unblurred base and the final output at 100%; its presence does not relax geometry, identity, object, text, or content preservation.

## Aesthetic difference checks

Record mean absolute RGB difference, P95 per-pixel RGB difference, mean absolute luminance difference, and the fraction of pixels changing by at least `2/255`. These are not beauty scores. Use them only to catch a mismatch between the selected intensity and a nearly unchanged output.

For transformative hue-range treatments, warn for insufficient magnitude only when both the global mean RGB delta is below `0.04` and P95 per-pixel delta is below `0.09`. A high localized P95 delta may represent the exact requested color-family transformation in a mostly dark or neutral frame. Never increase exposure, contrast, or unrelated color merely to lift the global mean above a threshold.

## Reference-aware checks

When a reference is supplied, record source-to-reference and output-to-reference distribution distances using shadow-through-highlight luminance percentiles, saturation quartiles, channel means, and shadow/midtone/highlight color tendencies. Report tone, chroma, global-color, and tonal-zone-color progress separately. Require at least 20%, 40%, 60%, or 75% overall improvement for conservative, standard, bold, or transformative matching. Keep preservation status separate from target-match status.

Generate evidence-based recommendations from the remaining deltas. Recommend one conceptual adjustment at a time: exposure, tonal contrast, the single active chroma control, color balance, or uncertain skin protection. Recommendations are iteration aids, not automatic permission to exceed recipe bounds.

Use the larger of source and reference clipping, near-black, and extreme-saturation fractions as the baseline before warning. Do not force a deliberately strong reference back toward neutral merely because its target distribution contains deep blacks or saturated colors.

For transformative work, distinguish intended boundary crossing from defects. Large deliberate hue, chroma, near-black, or channel-mean changes are acceptable when named by the treatment contract or present in a supplied reference. New clipping, banding, non-finite values, hard color-selection seams, and unintended movement of protected exceptions remain failures or warnings. Require 75% distribution improvement for a pure transformative reference match, but use contract-specific evidence as well when the request intentionally matches only selected color families rather than the reference's full distribution.

When an explicit transformative contract deliberately darkens non-subject surroundings and no reference is available at execution time, schema 1.2 may record `quality_tolerances.intentional_near_black_increase`. Treat it as a bounded warning-baseline adjustment, never permission to crush shadows indiscriminately. The reason must describe the requested tonal hierarchy. Do not respond to an allowed near-black increase by raising exposure solely to make the metric neutral.
