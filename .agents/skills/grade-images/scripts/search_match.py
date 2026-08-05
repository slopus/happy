# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from compare import gradient_metrics, reference_match_metrics
from grade_core import (
    analyze_array,
    load_image,
    load_recipe,
    render_array,
    save_image,
    sha256_file,
    validate_recipe,
)
from match import derive_match_recipe
from variants import build_contact_sheet


STRENGTH_GRIDS = {
    "conservative": (0.30, 0.40, 0.49),
    "standard": (0.50, 0.65, 0.79),
    "bold": (0.80, 0.90, 1.00),
    "transformative": (0.92, 0.97, 1.00),
}


def _safety_failures(source: dict, result: dict, reference: dict, structure: dict) -> list[str]:
    failures = []
    allowed_clip = max(
        source["clipping"]["any_channel_high_fraction"],
        reference["clipping"]["any_channel_high_fraction"],
    )
    if result["clipping"]["any_channel_high_fraction"] > allowed_clip + 0.005:
        failures.append("high-channel clipping exceeds the source/reference allowance")
    allowed_black = max(
        source["clipping"]["near_black_fraction"],
        reference["clipping"]["near_black_fraction"],
    )
    if result["clipping"]["near_black_fraction"] > allowed_black + 0.02:
        failures.append("near-black coverage exceeds the source/reference allowance")
    allowed_extreme = max(
        source["saturation"]["extreme_fraction"],
        reference["saturation"]["extreme_fraction"],
    )
    if result["saturation"]["extreme_fraction"] > allowed_extreme + 0.01:
        failures.append("extreme saturation exceeds the source/reference allowance")
    if structure["strong_edge_orientation_agreement"] < 0.98:
        failures.append("strong-edge orientation agreement fell below 0.98")
    if structure["new_strong_edge_fraction"] > 0.01:
        failures.append("new strong-edge fraction exceeded 0.01")
    return failures


def search_reference_match(
    source_path: Path,
    reference_path: Path,
    template_path: Path,
    intensity: str,
    output_dir: Path,
    max_size: int = 1200,
    skin_protection: bool | None = None,
) -> dict[str, Any]:
    if intensity not in STRENGTH_GRIDS:
        raise ValueError("intensity must be conservative, standard, bold, or transformative")
    if max_size < 64:
        raise ValueError("max_size must be at least 64")
    source_hash_before = sha256_file(source_path)
    source, alpha, metadata = load_image(source_path, max_size=max_size)
    reference, _, _ = load_image(reference_path, max_size=max_size)
    template = load_recipe(template_path)
    source_analysis = analyze_array(source)
    reference_analysis = analyze_array(reference)
    output_dir.mkdir(parents=True, exist_ok=True)
    panels = [("Original", source), ("Reference", reference)]
    candidates = []
    rendered: dict[float, Any] = {}
    for strength in STRENGTH_GRIDS[intensity]:
        recipe, match_diagnostics = derive_match_recipe(
            source,
            reference,
            template,
            strength=strength,
            skin_protection=skin_protection,
        )
        recipe["strategy"]["intensity"] = intensity
        recipe["output"]["format"] = "png"
        validate_recipe(recipe)
        result, render_diagnostics = render_array(source, recipe)
        result_analysis = analyze_array(result)
        metrics = reference_match_metrics(source_analysis, result_analysis, reference_analysis)
        structure = gradient_metrics(source, result)
        failures = _safety_failures(source_analysis, result_analysis, reference_analysis, structure)
        key = f"{strength:.2f}".replace(".", "-")
        recipe_path = output_dir / f"candidate-{key}.json"
        result_path = output_dir / f"candidate-{key}.png"
        recipe_path.write_text(json.dumps(recipe, indent=2), encoding="utf-8")
        save_image(result_path, result, alpha, recipe, metadata)
        candidate = {
            "strength": strength,
            "status": "reject" if failures else "safe",
            "safety_failures": failures,
            "recipe": str(recipe_path.resolve()),
            "result": str(result_path.resolve()),
            "result_sha256": sha256_file(result_path),
            "match": metrics,
            "structure": structure,
            "match_diagnostics": match_diagnostics,
            "render_diagnostics": render_diagnostics,
        }
        candidates.append(candidate)
        rendered[strength] = result
        panels.append((
            f"{intensity.title()} {strength:.2f} | match {metrics['improvement_fraction']:+.0%}",
            result,
        ))

    safe = [candidate for candidate in candidates if candidate["status"] == "safe"]
    selected = min(
        safe,
        key=lambda candidate: (
            candidate["match"]["output_distribution_distance"],
            candidate["strength"],
        ),
        default=None,
    )
    if selected:
        selected_recipe = output_dir / "selected-recipe.json"
        selected_result = output_dir / "selected.png"
        shutil.copyfile(selected["recipe"], selected_recipe)
        shutil.copyfile(selected["result"], selected_result)
        selected_summary = {
            "strength": selected["strength"],
            "recipe": str(selected_recipe.resolve()),
            "result": str(selected_result.resolve()),
            "match": selected["match"],
            "selection_reason": "lowest reference-distribution distance among safety-passing candidates",
        }
    else:
        selected_summary = None
    sheet_path = output_dir / "match-search-comparison.png"
    build_contact_sheet(panels, sheet_path, columns=2)
    if sha256_file(source_path) != source_hash_before:
        raise RuntimeError("source file changed during reference search")
    report = {
        "schema_version": "1.0",
        "status": "pass" if selected_summary else "fail",
        "intensity": intensity,
        "strength_grid": list(STRENGTH_GRIDS[intensity]),
        "source": str(source_path.resolve()),
        "source_sha256": source_hash_before,
        "reference": str(reference_path.resolve()),
        "template": str(template_path.resolve()),
        "comparison_sheet": str(sheet_path.resolve()),
        "candidates": candidates,
        "selected": selected_summary,
        "rejected_candidate_count": len(candidates) - len(safe),
    }
    report_path = output_dir / "match-search-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["report"] = str(report_path.resolve())
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Search safe reference-match candidates within one user-selected intensity."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--intensity", required=True, choices=tuple(STRENGTH_GRIDS))
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--max-size", type=int, default=1200)
    parser.add_argument("--disable-skin-protection", action="store_true")
    args = parser.parse_args()
    try:
        report = search_reference_match(
            args.source,
            args.reference,
            args.template,
            args.intensity,
            args.output_dir,
            max_size=args.max_size,
            skin_protection=False if args.disable_skin_protection else None,
        )
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"error: {error}\n")
    print(report["comparison_sheet"])
    print(report["report"])
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
