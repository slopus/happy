# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from compare import gradient_metrics, reference_match_metrics
from grade_core import analyze_array, load_image, load_recipe, render_array, save_image, validate_recipe
from match import derive_match_recipe


def _resolve(root: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def run_regression(manifest_path: Path, output_dir: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != "1.0" or not isinstance(manifest.get("cases"), list):
        raise ValueError("regression manifest must use schema_version 1.0 and contain cases")
    root = manifest_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for index, case in enumerate(manifest["cases"]):
        if not isinstance(case, dict) or not all(key in case for key in ("name", "source", "reference", "template")):
            raise ValueError(f"case {index + 1} is missing name, source, reference, or template")
        name = str(case["name"])
        source_path = _resolve(root, str(case["source"]))
        reference_path = _resolve(root, str(case["reference"]))
        template_path = _resolve(root, str(case["template"]))
        strength = float(case.get("strength", 0.65))
        minimum = float(case.get("minimum_improvement_fraction", 0.0))
        source, alpha, metadata = load_image(source_path, max_size=int(case.get("max_size", 1600)))
        reference, _, _ = load_image(reference_path, max_size=int(case.get("max_size", 1600)))
        recipe, match_diagnostics = derive_match_recipe(
            source,
            reference,
            load_recipe(template_path),
            strength=strength,
            skin_protection=case.get("skin_protection"),
        )
        recipe["output"]["format"] = "png"
        validate_recipe(recipe)
        result, render_diagnostics = render_array(source, recipe)
        metrics = reference_match_metrics(
            analyze_array(source), analyze_array(result), analyze_array(reference)
        )
        structure = gradient_metrics(source, result)
        edge_limit = float(case.get("minimum_edge_orientation_agreement", 0.98))
        new_edge_limit = float(case.get("maximum_new_edge_fraction", 0.01))
        failures = []
        if metrics["improvement_fraction"] < minimum:
            failures.append(
                f"distribution improvement {metrics['improvement_fraction']:.3f} is below {minimum:.3f}"
            )
        if structure["strong_edge_orientation_agreement"] < edge_limit:
            failures.append("strong-edge orientation agreement is below the case limit")
        if structure["new_strong_edge_fraction"] > new_edge_limit:
            failures.append("new strong-edge fraction exceeds the case limit")
        case_dir = output_dir / f"{index + 1:02d}-{_safe_name(name)}"
        case_dir.mkdir(parents=True, exist_ok=True)
        recipe_path = case_dir / "recipe.json"
        result_path = case_dir / "result.png"
        recipe_path.write_text(json.dumps(recipe, indent=2), encoding="utf-8")
        save_image(result_path, result, alpha, recipe, metadata)
        results.append({
            "name": name,
            "direction": case.get("direction"),
            "status": "fail" if failures else "pass",
            "failures": failures,
            "metrics": metrics,
            "structure": structure,
            "match_diagnostics": match_diagnostics,
            "render_diagnostics": render_diagnostics,
            "recipe": str(recipe_path.resolve()),
            "result": str(result_path.resolve()),
        })
    report = {
        "schema_version": "1.0",
        "status": "fail" if any(case["status"] == "fail" for case in results) else "pass",
        "manifest": str(manifest_path.resolve()),
        "cases": results,
    }
    report_path = output_dir / "regression-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["report"] = str(report_path.resolve())
    return report


def _safe_name(value: str) -> str:
    safe = "".join(character.lower() if character.isalnum() else "-" for character in value)
    return "-".join(part for part in safe.split("-") if part) or "case"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run opt-in local reference-match regression cases.")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = run_regression(args.manifest, args.output_dir)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"error: {error}\n")
    print(report["report"])
    return 1 if report["status"] == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
