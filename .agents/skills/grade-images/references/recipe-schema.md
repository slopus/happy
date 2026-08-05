# Recipe schema

## Top-level structure

Every recipe is JSON with these allowed keys:

- `schema_version`: `1.0` for the original color-only schema, `1.1` for vibrance and controlled effects, or `1.2` for deterministic hue-range remapping.
- `intent`: short human-readable explanation.
- `strategy`: selected aesthetic strategy and how it was selected.
- `preservation`: strict execution policy.
- `correction`: source-specific technical correction.
- `look`: reusable creative treatment.
- `effects`: optional, explicitly approved source-derived light diffusion.
- `protection`: protected-region settings.
- `quality_tolerances`: optional schema 1.2 warning-baseline allowance for an explicitly requested transformative tonal hierarchy.
- `output`: encoding settings.

Unknown keys fail validation.

## Strategy

Use this optional object for new recipes:

```json
{
  "intensity": "standard",
  "style": "natural",
  "selection": "explicit"
}
```

- `intensity`: `conservative`, `standard`, `bold`, or `transformative`.
- `style`: `technical`, `natural`, `cinematic`, `reference`, or `custom`.
- `selection`: `explicit`, `inferred`, `default-standard`, or `template`.

This field records the decision; it does not weaken strict preservation. Legacy recipes without it remain valid.

## Preservation

```json
{
  "mode": "strict",
  "allow_geometry_changes": false,
  "allow_texture_changes": false,
  "allow_generative_changes": false
}
```

All four values are mandatory in v0.3 and must match the example exactly.

## Correction

Allowed keys and ranges:

- `exposure_ev`: `-3.0..3.0`
- `white_balance.rgb_gains`: three values in `0.5..2.0`
- `black_point`: `0.0..0.2`
- `white_point`: `0.8..1.5`, greater than `black_point`
- `highlight_rolloff`: `0.0..1.0`

Prefer explicit RGB gains over ambiguous Kelvin values. Record how the gains were chosen in `intent` or the surrounding quality report.

## Look

Allowed keys and ranges:

- `tone_curve.strength`: `-1.0..1.0`; positive values create a safe S-curve, negative values soften contrast.
- `cdl.slope`: three values in `0.25..4.0`
- `cdl.offset`: three values in `-0.25..0.25`
- `cdl.power`: three values in `0.25..4.0`
- `cdl.saturation`: `0.0..2.0`
- `saturation`: `0.0..2.0`
- `vibrance`: schema 1.1 or 1.2, `-1.0..2.0`; positive values affect muted colors more than saturated colors, while negative values create a soft color wash without uniformly crushing strong signature colors.
- `split_tone.shadows`: RGB triplet in `0.0..1.0`
- `split_tone.highlights`: RGB triplet in `0.0..1.0`
- `split_tone.balance`: `-1.0..1.0`
- `split_tone.strength`: `0.0..0.25`
- `hue_ranges`: schema 1.2 only; up to eight smoothly feathered source-color ranges.

The renderer applies correction before look.

Use only one chroma control: `cdl.saturation`, `saturation`, or `vibrance`. Validation rejects stacked controls. Treat natural color as a hue/white-balance goal, not as a request to desaturate.

### Hue ranges (schema 1.2)

Use hue ranges only when the treatment contract explicitly requests a selective or major color-family change. Each item accepts:

- `label`: optional human-readable rationale;
- `center_degrees`: source hue center in `0..360`;
- `width_degrees`: full-strength hue width in `1..180`;
- `feather_degrees`: outer hue feather in `0..90`, no greater than the width;
- `hue_shift_degrees`: signed source hue rotation in `-180..180`;
- `saturation_scale`: source saturation multiplier in `0..2`;
- `luminance_scale`: source luminance multiplier in `0.25..2`;
- `saturation_range` and `luminance_range`: two-value source-selection bounds in `0..1`;
- `range_feather`: smooth feather outside those bounds in `0..0.25`;
- `strength`: blend strength in `0..1`.

Selection is computed from source-derived pixel color, never an object label or generated mask. Hue remapping runs before the global chroma control so a highly saturated excluded color does not become eligible merely because the recipe later desaturates it. Keep feathers broad enough to avoid banding and inspect color boundaries at 100%.

## Effects

Effects require `schema_version: 1.1` or `1.2`. Omit `effects` for color-only work. An enabled effect must use:

```json
{
  "permission": "source-derived",
  "selection": "explicit-user",
  "source_glow": {
    "enabled": true,
    "threshold": 0.6,
    "knee": 0.12,
    "radius_fraction": 0.015,
    "strength": 0.1
  }
}
```

- `threshold`: source linear-luminance threshold, `0.25..0.95`.
- `knee`: soft threshold width, `0.0..0.30`.
- `radius_fraction`: Gaussian radius as a fraction of the shorter image edge, `0.001..0.05`.
- `strength`: bounded screen-like light addition, `0.0..0.35`; enabled effects require a positive value.

If an `effects` object is present but disabled, it must use `permission: none` and `selection: not-required`. Unknown effects fail validation. Lens flare, rays, starbursts, artificial halos, light-source insertion, overlays, and arbitrary masks have no schema representation and are forbidden.

## Protection

```json
{
  "skin": {
    "enabled": true,
    "strength": 0.7
  }
}
```

`strength` is `0.0..1.0` and controls how much of the grade is removed in high-confidence skin regions. Disable skin protection for images without people when visual inspection confirms that choice.

## Quality tolerances

Schema 1.2 transformative recipes may record:

```json
{
  "intentional_near_black_increase": 0.18,
  "reason": "The requested low-key treatment deliberately darkens non-subject surroundings"
}
```

The increase is limited to `0.0..0.25`, requires a non-empty reason, and only changes the near-black warning baseline. It never relaxes clipping, non-finite values, dimensions, alpha, structure, new-edge, texture, effect-consent, or content-preservation gates. Do not add it merely to silence a warning; use it only when the treatment contract explicitly requires a darker tonal hierarchy or a reviewed reference demonstrates one.

## Output

Allowed keys:

- `format`: `png` or `jpeg`
- `quality`: integer `85..100`; used only for JPEG
- `profile`: currently `sRGB`
- `preserve_metadata`: boolean

The command-line output suffix must agree with `format`.
