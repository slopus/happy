# Intensity strategies

## Separate preservation from intensity

Keep `preservation.mode: strict` at every intensity. Conservative, standard, bold, and transformative describe how far tone and color may move, never whether geometry, identity, objects, facial features, or texture may change.

Intensity never grants effect permission. A conservative or standard dream look may need source-derived diffusion; a bold vivid look may need none. Follow [controlled-light-effects.md](controlled-light-effects.md) when an optical-light quality is implied.

## Ask or infer

For a subjective `look` request with no clear intensity cue, ask the user to choose:

- **Conservative**: subtle cleanup; retain the source mood.
- **Standard**: clearly improved and visibly different without dominating the photograph.
- **Bold**: unmistakable creative treatment within clipping and gamut limits.
- **Transformative**: a major, prompt-directed change to color relationships or tonal hierarchy while strict structural preservation remains unchanged.

If the user does not answer and continuing is appropriate, use `standard` and say so. Do not ask again when the prompt already contains a clear cue.

Map language as follows:

- `保守`, `轻微`, `微调`, `克制`, `subtle`, `restrained` -> `conservative`
- no intensity cue -> ask; otherwise `standard`
- `放开调`, `强烈`, `大胆`, `浓郁`, `明显`, `极致`, `bold`, `dramatic` -> `bold`
- `变革型`, `大幅改变`, `彻底改变`, `完全换一种色调`, `大幅压低黄色`, `整体明显偏紫`, `transformative`, `radically recolor`, or an equally explicit major-change instruction -> `transformative`

Do not infer transformative merely from a mood word such as `清冷`, `神性`, `史诗感`, or `温馨下午`. Mood selects a direction; explicit magnitude language selects transformative. If the user directly chooses the transformative strategy, honor it without weakening the result back to bold.

Treat `自然`, `真实`, `电影感`, `胶片感`, and named moods as style cues, not intensity cues. In particular, `自然` never means `conservative` or `desaturated` by itself.

## Outcome targets

Use these as starting ranges, not rigid numeric goals. Scene analysis and clipping limits still govern the final values.

| Strategy | Visible outcome | Typical tone curve | Typical effective saturation | Typical split-tone strength |
| --- | --- | ---: | ---: | ---: |
| Conservative | Difference is visible side by side but does not announce itself | `0.04..0.16` | `0.97..1.06` | `0.00..0.05` |
| Standard | Difference is clear at fit-to-screen size | `0.16..0.36` | `0.95..1.12` | `0.04..0.12` |
| Bold | Treatment is unmistakable without clipping or fluorescent color | `0.30..0.58` | `0.92..1.22` | `0.09..0.18` |
| Transformative | Major color-family or tonal-hierarchy change is obvious in isolation | `0.38..0.75` | `0.35..1.45`, according to intent | `0.00..0.22` |

Transformative is not simply “more of every slider.” Write a treatment contract first: magnitude, requested axes, direction, scope, must-be-obvious outcome, protected exceptions, and effect status. Prefer a selective hue range when the prompt names a source color family or requests that one family become another. Keep unrelated operations restrained.

Example contract for `变革型；希望樱花为浅紫色，有清冷神性的氛围`:

- magnitude: transformative;
- axes: warm-to-violet hue remap, global yellow suppression, darker non-subject tone, restrained chroma;
- scope: source warm/pale colors meeting explicit hue, saturation, and luminance gates; no claimed semantic flower mask;
- must be obvious: blossoms read pale violet and the warm ambient cast no longer controls the frame;
- protected: dimensions, branches, petals, people, signs, texture, edges, and native light locations;
- effects: absent unless source-derived diffusion is separately proposed and explicitly approved. The word `神性` alone does not require an effect when color and tone already satisfy the request.

Use only one chroma control. Prefer `vibrance` for strong enhancement from a muted source or for a soft wash that should retain selected signature colors. Stacking `cdl.saturation`, `saturation`, and `vibrance` fails validation.

## Interpret styles correctly

### Natural

Preserve believable relationships and signature colors. Correct casts using white balance and tonal shaping first. Do not reduce saturation merely because the source is colorful. Reduce chroma only where preview inspection shows clipping, hue breakage, or a fluorescent appearance. `极致自然美` maps to `natural + bold`: luminous, clean, and vivid while remaining plausible, with no split toning unless explicitly requested.

### Cinematic

Build the look through tonal density, controlled color separation, and subject emphasis. Cinematic does not automatically mean faded or desaturated. For standard and bold strategies, the before/after should be plainly distinguishable. Protect important colors such as skin, sky, foliage, product colors, or a red lighthouse instead of flattening the whole image.

### Reference

Expose strength explicitly. Treat `0.35`, `0.65`, and `0.90` as conservative, standard, and bold starting points. Report when source/reference differences prevent a strong safe match.

## Preview decision

Label every preview with style and intensity. For `standard`, `bold`, or `transformative`, treat a low-difference warning from `compare.py` as a reason to revise the recipe, not as a successful result, unless clipping/gamut limits are documented. Transformative should also be judged against its treatment contract; a localized but decisive hue-family change may be more meaningful than a larger global mean delta. When uncertain between two interpretations, offer two previews rather than silently choosing the weaker one.
