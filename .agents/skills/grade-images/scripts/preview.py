# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

from compare import (
    difference_metrics,
    gradient_metrics,
    reference_adjustment_suggestions,
    reference_match_metrics,
    strategy_warnings,
)
from grade_core import (
    RecipeError,
    analyze_array,
    load_image,
    load_recipe,
    render_array,
    save_image,
    sha256_file,
)
from variants import build_contact_sheet


REFERENCE_REQUIREMENTS = {
    "conservative": 0.20,
    "standard": 0.40,
    "bold": 0.60,
    "transformative": 0.75,
}


def _quality_report(
    source,
    result,
    recipe: dict,
    reference=None,
) -> dict:
    source_analysis = analyze_array(source)
    result_analysis = analyze_array(result)
    reference_analysis = analyze_array(reference) if reference is not None else None
    difference = difference_metrics(source, result)
    structure = gradient_metrics(source, result)
    warnings = strategy_warnings(recipe, difference)
    recommendations = []

    allowed_clip = max(
        source_analysis["clipping"]["any_channel_high_fraction"],
        reference_analysis["clipping"]["any_channel_high_fraction"]
        if reference_analysis else 0.0,
    )
    if result_analysis["clipping"]["any_channel_high_fraction"] > allowed_clip + 0.005:
        warnings.append("high-channel clipping increased by more than 0.5 percentage points")
    intentional_black = float(
        recipe.get("quality_tolerances", {}).get("intentional_near_black_increase", 0.0)
    )
    allowed_black = max(
        source_analysis["clipping"]["near_black_fraction"] + intentional_black,
        reference_analysis["clipping"]["near_black_fraction"] if reference_analysis else 0.0,
    )
    if result_analysis["clipping"]["near_black_fraction"] > allowed_black + 0.02:
        warnings.append("near-black pixels increased by more than 2 percentage points; review shadow detail")
    allowed_extreme = max(
        source_analysis["saturation"]["extreme_fraction"],
        reference_analysis["saturation"]["extreme_fraction"] if reference_analysis else 0.0,
    )
    if result_analysis["saturation"]["extreme_fraction"] > allowed_extreme + 0.01:
        warnings.append("extreme saturation increased by more than 1 percentage point")
    if structure["strong_edge_orientation_agreement"] < 0.98:
        warnings.append("strong-edge orientation agreement fell below 0.98")
    glow_enabled = recipe.get("effects", {}).get("source_glow", {}).get("enabled", False)
    new_edge_limit = 0.04 if glow_enabled else 0.01
    if structure["new_strong_edge_fraction"] > new_edge_limit:
        warnings.append(
            f"new strong-edge or glow-boundary gradients exceed {new_edge_limit:.0%} of pixels"
        )

    target_match = {}
    if reference_analysis:
        target_match = reference_match_metrics(source_analysis, result_analysis, reference_analysis)
        required = REFERENCE_REQUIREMENTS.get(
            recipe.get("strategy", {}).get("intensity"), 0.40
        )
        target_match["required_improvement_fraction"] = required
        target_match["passed"] = target_match["improvement_fraction"] >= required
        if not target_match["passed"]:
            warnings.append(
                f"reference distribution match did not reach the {required:.0%} improvement required for this intensity"
            )
            recommendations = reference_adjustment_suggestions(result_analysis, reference_analysis)

    return {
        "schema_version": "1.0",
        "status": "warn" if warnings else "pass",
        "warnings": warnings,
        "recommendations": recommendations,
        "structure": structure,
        "difference": difference,
        "target_match": target_match,
        "source": source_analysis,
        "output": result_analysis,
        "reference": reference_analysis,
    }


def render_preview(
    input_path: Path,
    recipe_path: Path,
    output_dir: Path,
    max_size: int = 1200,
    reference_path: Path | None = None,
    label: str | None = None,
) -> dict:
    if max_size < 64:
        raise ValueError("max_size must be at least 64")
    started = time.perf_counter()
    source_hash = sha256_file(input_path)
    recipe = load_recipe(recipe_path)
    source, alpha, metadata = load_image(input_path, max_size=max_size)
    load_elapsed = time.perf_counter() - started
    render_started = time.perf_counter()
    result, diagnostics = render_array(source, recipe)
    render_elapsed = time.perf_counter() - render_started
    reference = None
    if reference_path:
        reference, _, _ = load_image(reference_path, max_size=max_size)

    output_dir.mkdir(parents=True, exist_ok=True)
    extension = ".jpg" if recipe["output"].get("format") == "jpeg" else ".png"
    preview_path = output_dir / f"{input_path.stem}--preview{extension}"
    recipe_copy = output_dir / f"{input_path.stem}--preview.recipe.json"
    report_path = output_dir / f"{input_path.stem}--preview.report.json"
    sheet_path = output_dir / f"{input_path.stem}--preview.comparison.png"
    if preview_path.resolve() == input_path.resolve():
        raise RecipeError("preview output must not overwrite the input")

    save_started = time.perf_counter()
    save_image(preview_path, result, alpha, recipe, metadata)
    shutil.copyfile(recipe_path, recipe_copy)
    report = _quality_report(source, result, recipe, reference=reference)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    strategy = recipe.get("strategy", {})
    display_label = label or " · ".join(
        part.title() for part in (
            strategy.get("intensity", "Preview"),
            strategy.get("style", "Custom"),
        )
    )
    panels = [("Original", source), (display_label, result)]
    if reference is not None:
        panels.append(("Reference", reference))
    build_contact_sheet(panels, sheet_path, columns=2)
    save_elapsed = time.perf_counter() - save_started
    if sha256_file(input_path) != source_hash:
        raise RuntimeError("source file changed during preview rendering")

    manifest = {
        "schema_version": "1.0",
        "input": str(input_path.resolve()),
        "input_sha256": source_hash,
        "recipe": str(recipe_copy.resolve()),
        "preview": str(preview_path.resolve()),
        "comparison_sheet": str(sheet_path.resolve()),
        "quality_report": str(report_path.resolve()),
        "quality_status": report["status"],
        "max_size": max_size,
        "render_diagnostics": diagnostics,
        "timing_seconds": {
            "load": round(load_elapsed, 4),
            "render": round(render_elapsed, 4),
            "save_report_sheet": round(save_elapsed, 4),
            "total": round(time.perf_counter() - started, 4),
        },
    }
    manifest_path = output_dir / f"{input_path.stem}--preview.manifest.json"
    manifest["manifest"] = str(manifest_path.resolve())
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render, compare, label, and report one deterministic preview in a single pass."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--recipe", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--max-size", type=int, default=1200)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--label")
    args = parser.parse_args()
    try:
        manifest = render_preview(
            args.input,
            args.recipe,
            args.output_dir,
            max_size=args.max_size,
            reference_path=args.reference,
            label=args.label,
        )
    except (RecipeError, OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"error: {error}\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
