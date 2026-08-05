# Preview and regression testing

## Compare alternatives

For a single baseline treatment, start with the combined fast preview command:

```text
python scripts/preview.py INPUT --recipe RECIPE.json \
  --output-dir previews --max-size 1200 [--reference REFERENCE]
```

It writes the preview, copied recipe, quality report, comparison sheet, manifest, and per-stage timings in one process. Use it instead of separately invoking render, compare, and a hand-written contact-sheet script.

Use `variants.py` when a subjective request has multiple plausible interpretations or the user wants to choose intensity. Supply independently authored recipes; do not create cosmetic labels for nearly identical parameters.

```text
python scripts/variants.py INPUT \
  --variant conservative=CONSERVATIVE.json \
  --variant standard=STANDARD.json \
  --variant bold=BOLD.json \
  --variant transformative=TRANSFORMATIVE.json \
  --output-dir previews --max-size 1200
```

The command keeps each preview and exact recipe, records visual-difference metrics, and creates a labeled contact sheet containing the original. Inspect the individual files at 100% before accepting a result. A contact sheet is for choosing direction, not for final quality approval.

To derive conservative, standard, bold, and transformative variants from one reviewed base recipe, run:

```text
python scripts/variants.py INPUT --base-recipe BASE.json --output-dir previews
```

Automatic derivation scales only the creative `look` relative to its neutral centers. It keeps technical correction, protection settings, and effect permission unchanged. The base recipe's declared intensity remains numerically identical in its corresponding derived variant.

When intensity is already explicit, compare treatments at that intensity, such as `natural-bold`, `rich-bold`, and `soft-bold`. Keep effect permission identical across variants unless the user explicitly asked to compare an approved source-derived effect against a color-only limit.

## Run private regression cases

Keep private or copyrighted photographs outside the repository. Point a local manifest to them and run:

```text
python scripts/regress.py cases.json --output-dir regression-results
```

Manifest format:

```json
{
  "schema_version": "1.0",
  "cases": [
    {
      "name": "soft-to-rich",
      "direction": "soft-to-rich",
      "source": "private/soft.jpg",
      "reference": "private/rich.jpg",
      "template": "../assets/recipes/neutral-correction.json",
      "strength": 0.9,
      "minimum_improvement_fraction": 0.4,
      "skin_protection": false
    }
  ]
}
```

Paths are relative to the manifest unless absolute. Set thresholds from a reviewed baseline, not from the desired answer. Include both directions as separate cases. A passing metric does not replace visual review.

## Search within a chosen reference intensity

After the user chooses one intensity, search three bounded strengths inside that intensity only:

```text
python scripts/search_match.py SOURCE REFERENCE \
  --template assets/recipes/neutral-correction.json \
  --intensity bold --output-dir match-search
```

Select the lowest reference-distribution distance among candidates that pass clipping, near-black, extreme-saturation, edge-orientation, and new-edge gates. Never cross into another intensity to improve a metric. If every candidate fails safety, return no selection and request review instead of silently weakening or accepting the result.

## Regression discipline

- Establish the previous release baseline before changing renderer behavior.
- Keep structural and intent-match results separate.
- Treat a direction that improves while its reverse regresses as a failed bidirectional change.
- Record recipes and reports, but never commit private source images.
- Add synthetic fixtures for engine invariants and use private photos only for local perceptual coverage.
- Benchmark end-to-end preview time separately from model reasoning time. If local render and comparison take seconds but the task takes minutes, optimize preset routing and iteration count rather than weakening image processing.
- For every schema 1.2 hue-range case, test circular hue wrapping, smooth boundary response, near-neutral exclusion, deterministic output, and rejection of semantic-mask or unknown-operation fields.
- For transformative private cases, record the treatment contract beside the manifest and review the named must-be-obvious outcome visually. Distribution improvement alone cannot prove that the requested color family moved correctly.
