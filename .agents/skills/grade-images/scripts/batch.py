# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import copy
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from grade_core import load_image, load_recipe, sha256_file, validate_recipe
from match import bounded_geometric_normalize, image_match_stats


def _geometric_normalize(values: np.ndarray) -> np.ndarray:
    safe = np.clip(values.astype(np.float64), 1e-6, None)
    return safe / float(np.prod(safe) ** (1.0 / len(safe)))


def derive_batch_recipes(
    inputs: list[Path],
    shared_template: dict[str, Any],
    strength: float = 0.8,
) -> tuple[list[tuple[Path, dict[str, Any]]], dict[str, Any]]:
    if not inputs:
        raise ValueError("at least one input is required")
    if not 0.0 <= strength <= 1.0:
        raise ValueError("strength must be in [0, 1]")
    records = []
    for path in inputs:
        rgb, _, _ = load_image(path, max_size=1600)
        records.append({"path": path, "stats": image_match_stats(rgb), "sha256": sha256_file(path)})

    target_luma = float(np.median([record["stats"]["luma"]["p50"] for record in records]))
    target_balance = _geometric_normalize(
        np.median(np.stack([record["stats"]["balance"] for record in records]), axis=0)
    )
    results: list[tuple[Path, dict[str, Any]]] = []
    manifest_images = []
    for record in records:
        stats = record["stats"]
        exposure_delta = math.log2(max(target_luma, 1e-6) / max(stats["luma"]["p50"], 1e-6))
        exposure_delta = float(np.clip(exposure_delta * strength, -1.25, 1.25))
        gains = bounded_geometric_normalize((target_balance / stats["balance"]) ** strength, 0.8, 1.25)

        recipe = copy.deepcopy(shared_template)
        correction = recipe.setdefault("correction", {})
        correction["exposure_ev"] = round(float(correction.get("exposure_ev", 0.0)) + exposure_delta, 6)
        base_gains = np.asarray(
            correction.setdefault("white_balance", {}).get("rgb_gains", [1.0, 1.0, 1.0]), dtype=np.float64
        )
        combined_gains = bounded_geometric_normalize(base_gains * gains, 0.75, 1.33)
        correction["white_balance"]["rgb_gains"] = [round(float(value), 6) for value in combined_gains]
        recipe["intent"] = (
            f"Per-image batch normalization at strength {strength:.2f}; "
            f"shared look: {shared_template.get('intent', 'unspecified')}"
        )
        validate_recipe(recipe)
        results.append((record["path"], recipe))
        manifest_images.append(
            {
                "input": str(record["path"].resolve()),
                "sha256": record["sha256"],
                "source_luminance_median": stats["luma"]["p50"],
                "exposure_delta_ev": exposure_delta,
                "white_balance_rgb_gains": [float(value) for value in combined_gains],
            }
        )
    manifest = {
        "schema_version": "1.0",
        "strength": strength,
        "target_luminance_median": target_luma,
        "target_balance": [float(value) for value in target_balance],
        "images": manifest_images,
    }
    return results, manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Create per-image correction recipes with one shared look.")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--look", required=True, type=Path)
    parser.add_argument("--strength", type=float, default=0.8)
    parser.add_argument("--disable-skin-protection", action="store_true")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    template = load_recipe(args.look)
    if args.disable_skin_protection:
        template.setdefault("protection", {}).setdefault("skin", {})["enabled"] = False
    recipes, manifest = derive_batch_recipes(args.inputs, template, args.strength)
    manifest["skin_protection_enabled"] = template.get("protection", {}).get("skin", {}).get("enabled", False)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem_counts = Counter(path.stem.casefold() for path, _ in recipes)
    for index, (path, recipe) in enumerate(recipes):
        if stem_counts[path.stem.casefold()] > 1:
            identity = sha256_file(path)[:8]
            filename = f"{path.stem}-{identity}-{index + 1}.grade.json"
        else:
            filename = f"{path.stem}.grade.json"
        destination = args.output_dir / filename
        destination.write_text(json.dumps(recipe, indent=2), encoding="utf-8")
        manifest["images"][index]["recipe"] = str(destination.resolve())
    manifest_path = args.output_dir / "batch-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
