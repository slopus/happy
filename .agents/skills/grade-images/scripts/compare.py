# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from grade_core import analyze_array, load_image, load_recipe


def _distribution_signature(analysis: dict) -> np.ndarray:
    luma = analysis["luminance_percentiles_linear"]
    saturation = analysis["saturation"]
    return np.asarray(
        [
            luma["5"],
            luma.get("25", luma["5"]),
            luma["50"],
            luma.get("75", luma["95"]),
            luma["95"],
            saturation.get("p25", saturation["median"]),
            saturation["median"],
            saturation.get("p75", saturation["p95"]),
            saturation["p95"],
            *analysis["channel_mean_srgb"],
            *analysis.get("tonal_zone_mean_srgb", {}).get("shadows", analysis["channel_mean_srgb"]),
            *analysis.get("tonal_zone_mean_srgb", {}).get("midtones", analysis["channel_mean_srgb"]),
            *analysis.get("tonal_zone_mean_srgb", {}).get("highlights", analysis["channel_mean_srgb"]),
        ],
        dtype=np.float64,
    )


def reference_match_metrics(source: dict, output: dict, reference: dict) -> dict[str, float]:
    weights = np.asarray(
        [1.0, 1.1, 1.5, 1.1, 1.0, 0.8, 1.2, 1.0, 0.8, 0.35, 0.35, 0.35,
         0.25, 0.25, 0.25, 0.35, 0.35, 0.35, 0.25, 0.25, 0.25],
        dtype=np.float64,
    )
    reference_signature = _distribution_signature(reference)
    source_distance = float(np.average(np.abs(_distribution_signature(source) - reference_signature), weights=weights))
    output_distance = float(np.average(np.abs(_distribution_signature(output) - reference_signature), weights=weights))
    if source_distance <= 1e-8:
        improvement = 1.0 if output_distance <= 1e-8 else 0.0
    else:
        improvement = 1.0 - output_distance / source_distance
    metrics = {
        "source_distribution_distance": round(source_distance, 6),
        "output_distribution_distance": round(output_distance, 6),
        "improvement_fraction": round(float(improvement), 6),
    }
    groups = {
        "tone": slice(0, 5),
        "chroma": slice(5, 9),
        "global_color": slice(9, 12),
        "tonal_zone_color": slice(12, 21),
    }
    source_signature = _distribution_signature(source)
    output_signature = _distribution_signature(output)
    for name, section in groups.items():
        source_component = float(np.mean(np.abs(source_signature[section] - reference_signature[section])))
        output_component = float(np.mean(np.abs(output_signature[section] - reference_signature[section])))
        component_improvement = (
            1.0 if source_component <= 1e-8 and output_component <= 1e-8
            else (0.0 if source_component <= 1e-8 else 1.0 - output_component / source_component)
        )
        metrics[f"{name}_source_distance"] = round(source_component, 6)
        metrics[f"{name}_output_distance"] = round(output_component, 6)
        metrics[f"{name}_improvement_fraction"] = round(float(component_improvement), 6)
    return metrics


def reference_adjustment_suggestions(output: dict, reference: dict) -> list[dict[str, str]]:
    """Return evidence-based next adjustments, ordered by conceptual dimension."""
    suggestions: list[dict[str, str]] = []
    output_luma = output["luminance_percentiles_linear"]
    reference_luma = reference["luminance_percentiles_linear"]
    median_delta = float(reference_luma["50"] - output_luma["50"])
    if abs(median_delta) > 0.025:
        direction = "increase" if median_delta > 0.0 else "decrease"
        suggestions.append({
            "dimension": "exposure",
            "direction": direction,
            "message": f"{direction} exposure or midtone luminance before changing color",
            "evidence": f"output/reference linear median: {output_luma['50']:.3f}/{reference_luma['50']:.3f}",
        })

    output_range = max(float(output_luma["95"] - output_luma["5"]), 1e-6)
    reference_range = max(float(reference_luma["95"] - reference_luma["5"]), 1e-6)
    range_ratio = reference_range / output_range
    if range_ratio > 1.18 or range_ratio < 0.82:
        direction = "increase" if range_ratio > 1.0 else "soften"
        suggestions.append({
            "dimension": "tonal_contrast",
            "direction": direction,
            "message": f"{direction} tonal contrast; review shadow and highlight separation together",
            "evidence": f"target/output P05-P95 range ratio: {range_ratio:.3f}",
        })

    output_sat = output["saturation"]
    reference_sat = reference["saturation"]
    median_ratio = float(reference_sat["median"] / max(output_sat["median"], 0.05))
    p95_ratio = float(reference_sat["p95"] / max(output_sat["p95"], 0.05))
    if median_ratio > 1.12 and p95_ratio < median_ratio - 0.12:
        suggestions.append({
            "dimension": "chroma",
            "direction": "increase_muted",
            "message": "increase vibrance rather than global saturation",
            "evidence": f"median/P95 saturation ratios: {median_ratio:.3f}/{p95_ratio:.3f}",
        })
    elif median_ratio > 1.12 and p95_ratio > 1.08:
        suggestions.append({
            "dimension": "chroma",
            "direction": "increase_global",
            "message": "increase the single active chroma control within gamut limits",
            "evidence": f"median/P95 saturation ratios: {median_ratio:.3f}/{p95_ratio:.3f}",
        })
    elif median_ratio < 0.88 or p95_ratio < 0.85:
        suggestions.append({
            "dimension": "chroma",
            "direction": "decrease",
            "message": "reduce the single active chroma control; preserve signature colors with vibrance when useful",
            "evidence": f"median/P95 saturation ratios: {median_ratio:.3f}/{p95_ratio:.3f}",
        })

    output_color = np.asarray(output["channel_mean_srgb"], dtype=np.float64)
    reference_color = np.asarray(reference["channel_mean_srgb"], dtype=np.float64)
    output_chroma = output_color - float(np.mean(output_color))
    reference_chroma = reference_color - float(np.mean(reference_color))
    color_delta = reference_chroma - output_chroma
    if float(np.linalg.norm(color_delta)) > 0.025:
        channel = ("red", "green", "blue")[int(np.argmax(color_delta))]
        suggestions.append({
            "dimension": "color_balance",
            "direction": f"toward_{channel}",
            "message": f"move color balance toward {channel}; verify neutral objects and skin visually",
            "evidence": f"normalized RGB tendency delta: {[round(float(value), 4) for value in color_delta]}",
        })
    return suggestions


def equalized_luminance(rgb: np.ndarray) -> np.ndarray:
    # Robust normalization removes global exposure/contrast differences without
    # the quantization edges introduced by per-image histogram equalization.
    luma = np.sum(rgb * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), axis=2)
    low, high = np.percentile(luma, [1, 99])
    return np.clip((luma - low) / max(float(high - low), 1e-6), 0.0, 1.0)


def gradient_metrics(source: np.ndarray, output: np.ndarray) -> dict[str, float]:
    src = equalized_luminance(source)
    dst = equalized_luminance(output)
    sy, sx = np.gradient(src)
    dy, dx = np.gradient(dst)
    sm = np.hypot(sx, sy)
    dm = np.hypot(dx, dy)
    # Do not promote ordinary smooth gradients into edges merely because they
    # occupy the top percentile of an otherwise low-detail image.
    threshold = max(float(np.percentile(sm, 90)), 0.02)
    strong = sm >= threshold
    dot = sx * dx + sy * dy
    denom = sm * dm + 1e-8
    orientation = np.abs(dot / denom)
    agreement = float(np.mean(orientation[strong])) if np.any(strong) else 1.0
    output_threshold = max(float(np.percentile(dm, 95)), 0.02)
    new_edge = (dm >= output_threshold) & (sm <= 0.005) & (dm > sm * 3.0 + 0.01)
    return {
        "strong_edge_orientation_agreement": round(agreement, 6),
        "new_strong_edge_fraction": round(float(np.mean(new_edge)), 6),
    }


def difference_metrics(source: np.ndarray, output: np.ndarray) -> dict[str, float]:
    absolute = np.abs(output.astype(np.float32) - source.astype(np.float32))
    pixel_delta = np.mean(absolute, axis=2)
    source_luma = np.sum(source * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), axis=2)
    output_luma = np.sum(output * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32), axis=2)
    return {
        "mean_absolute_rgb_delta": round(float(np.mean(absolute)), 6),
        "p95_pixel_rgb_delta": round(float(np.percentile(pixel_delta, 95)), 6),
        "mean_absolute_luma_delta": round(float(np.mean(np.abs(output_luma - source_luma))), 6),
        "changed_pixel_fraction_2_255": round(float(np.mean(pixel_delta >= (2.0 / 255.0))), 6),
    }


def strategy_warnings(recipe: dict, difference: dict[str, float]) -> list[str]:
    intensity = recipe.get("strategy", {}).get("intensity")
    mean_delta = difference["mean_absolute_rgb_delta"]
    p95_delta = difference["p95_pixel_rgb_delta"]
    warnings = []
    if intensity == "standard" and mean_delta < 0.015 and p95_delta < 0.04:
        warnings.append("standard strategy produced a low visual delta; review intent or strengthen the grade")
    elif intensity == "bold" and (mean_delta < 0.03 or p95_delta < 0.07):
        warnings.append("bold strategy did not produce a clearly strong visual delta; strengthen or explain the limit")
    elif intensity == "transformative" and mean_delta < 0.04 and p95_delta < 0.09:
        warnings.append(
            "transformative strategy produced neither a major global change nor a decisive localized change; revise the treatment contract or explain the limit"
        )
    elif intensity == "conservative" and mean_delta > 0.10:
        warnings.append("conservative strategy produced a large visual delta; review the grade")
    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Check preservation and clipping after a grade.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output_image", type=Path)
    parser.add_argument("--recipe", required=True, type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    recipe = load_recipe(args.recipe)
    source, source_alpha, _ = load_image(args.input)
    result, result_alpha, _ = load_image(args.output_image)
    hard_failures = []
    if source.shape != result.shape:
        hard_failures.append("image dimensions or channel topology changed")
    if (source_alpha is None) != (result_alpha is None):
        hard_failures.append("alpha structure changed")

    source_analysis = analyze_array(source)
    result_analysis = analyze_array(result)
    reference_analysis = None
    target_match = {}
    recommendations: list[dict[str, str]] = []
    if args.reference:
        reference_rgb, _, _ = load_image(args.reference)
        reference_analysis = analyze_array(reference_rgb)
        target_match = reference_match_metrics(source_analysis, result_analysis, reference_analysis)
        required_improvement = {
            "conservative": 0.20,
            "standard": 0.40,
            "bold": 0.60,
            "transformative": 0.75,
        }.get(recipe.get("strategy", {}).get("intensity"), 0.40)
        target_match["required_improvement_fraction"] = required_improvement
        target_match["passed"] = target_match["improvement_fraction"] >= required_improvement
        if not target_match["passed"]:
            recommendations.extend(reference_adjustment_suggestions(result_analysis, reference_analysis))
    warnings = []
    intent_warnings = []
    source_clip = source_analysis["clipping"]["any_channel_high_fraction"]
    result_clip = result_analysis["clipping"]["any_channel_high_fraction"]
    allowed_clip = max(source_clip, reference_analysis["clipping"]["any_channel_high_fraction"] if reference_analysis else 0.0)
    if result_clip > allowed_clip + 0.005:
        warnings.append("high-channel clipping increased by more than 0.5 percentage points")
    source_black = source_analysis["clipping"]["near_black_fraction"]
    result_black = result_analysis["clipping"]["near_black_fraction"]
    intentional_black = float(
        recipe.get("quality_tolerances", {}).get("intentional_near_black_increase", 0.0)
    )
    allowed_black = max(
        source_black + intentional_black,
        reference_analysis["clipping"]["near_black_fraction"] if reference_analysis else 0.0,
    )
    if result_black > allowed_black + 0.02:
        warnings.append("near-black pixels increased by more than 2 percentage points; review shadow detail")
    allowed_extreme = max(
        source_analysis["saturation"]["extreme_fraction"],
        reference_analysis["saturation"]["extreme_fraction"] if reference_analysis else 0.0,
    )
    if result_analysis["saturation"]["extreme_fraction"] > allowed_extreme + 0.01:
        warnings.append("extreme saturation increased by more than 1 percentage point")
    if recipe["output"].get("format", "png") == "jpeg":
        warnings.append("JPEG output is a lossy derivative")
    skin_enabled = recipe.get("protection", {}).get("skin", {}).get("enabled", False)
    if skin_enabled and source_analysis["skin_candidate_fraction"] < 0.001:
        warnings.append("skin protection was enabled but no reliable skin candidate was detected")
    if skin_enabled and source_analysis["skin_candidate_fraction"] > 0.35:
        warnings.append("skin candidate mask covers more than 35 percent; visually review for false positives")
        recommendations.append({
            "dimension": "skin_protection",
            "direction": "review_or_disable",
            "message": "review the heuristic mask and reduce or disable it if warm non-skin materials are protected",
            "evidence": f"candidate coverage: {source_analysis['skin_candidate_fraction']:.1%}",
        })

    structure = gradient_metrics(source, result) if source.shape == result.shape else {}
    difference = difference_metrics(source, result) if source.shape == result.shape else {}
    if difference:
        strategy_items = strategy_warnings(recipe, difference)
        intent_warnings.extend(strategy_items)
        warnings.extend(strategy_items)
    if target_match and not target_match["passed"]:
        required_percent = int(round(target_match["required_improvement_fraction"] * 100))
        target_warning = (
            f"reference distribution match did not reach the {required_percent} percent "
            "improvement required for this intensity; revise the recipe"
        )
        intent_warnings.append(target_warning)
        warnings.append(target_warning)
    if structure and structure["strong_edge_orientation_agreement"] < 0.98:
        warnings.append("strong-edge orientation agreement fell below 0.98")
    glow_enabled = recipe.get("effects", {}).get("source_glow", {}).get("enabled", False)
    new_edge_limit = 0.04 if glow_enabled else 0.01
    if structure and structure["new_strong_edge_fraction"] > new_edge_limit:
        warnings.append(
            f"new strong-edge or glow-boundary gradients exceed {new_edge_limit:.0%} of pixels"
        )

    preservation_warnings = [item for item in warnings if item not in intent_warnings]
    preservation_status = "fail" if hard_failures else ("warn" if preservation_warnings else "pass")
    intent_match_status = (
        "not_evaluated"
        if not target_match
        else ("warn" if intent_warnings else "pass")
    )

    report = {
        "schema_version": "1.1",
        "status": "fail" if hard_failures else ("warn" if warnings else "pass"),
        "preservation_status": preservation_status,
        "intent_match_status": intent_match_status,
        "hard_failures": hard_failures,
        "warnings": warnings,
        "preservation_warnings": preservation_warnings,
        "intent_warnings": intent_warnings,
        "recommendations": recommendations,
        "structure": structure,
        "difference": difference,
        "target_match": target_match,
        "source": source_analysis,
        "output": result_analysis,
        "reference": reference_analysis,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(args.output)
    return 1 if hard_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
