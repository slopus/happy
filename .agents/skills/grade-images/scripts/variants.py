# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from compare import difference_metrics, strategy_warnings
from grade_core import (
    RecipeError,
    load_image,
    load_recipe,
    render_array,
    save_image,
    sha256_file,
    validate_recipe,
)


INTENSITY_FACTORS = {
    "conservative": 0.55,
    "standard": 1.0,
    "bold": 1.55,
    "transformative": 2.20,
}


def _scaled(value: float, center: float, factor: float, low: float, high: float) -> float:
    return round(float(np.clip(center + (value - center) * factor, low, high)), 6)


def derive_intensity_recipe(base_recipe: dict[str, Any], intensity: str) -> dict[str, Any]:
    """Scale only the creative look; retain correction, protection, and effect consent."""
    if intensity not in INTENSITY_FACTORS:
        raise ValueError("intensity must be conservative, standard, bold, or transformative")
    recipe = copy.deepcopy(base_recipe)
    base_intensity = recipe.get("strategy", {}).get("intensity", "standard")
    base_factor = INTENSITY_FACTORS.get(base_intensity, 1.0)
    factor = INTENSITY_FACTORS[intensity] / base_factor
    strategy = recipe.setdefault("strategy", {})
    strategy["intensity"] = intensity
    strategy["selection"] = "inferred"
    if intensity != "transformative" and "quality_tolerances" in recipe:
        recipe["quality_tolerances"]["intentional_near_black_increase"] = 0.0
    look = recipe.setdefault("look", {})
    tone_curve = look.get("tone_curve", {})
    if "strength" in tone_curve:
        tone_curve["strength"] = _scaled(tone_curve["strength"], 0.0, factor, -1.0, 1.0)
    cdl = look.get("cdl", {})
    if "slope" in cdl:
        cdl["slope"] = [_scaled(value, 1.0, factor, 0.25, 4.0) for value in cdl["slope"]]
    if "offset" in cdl:
        cdl["offset"] = [_scaled(value, 0.0, factor, -0.25, 0.25) for value in cdl["offset"]]
    if "power" in cdl:
        cdl["power"] = [_scaled(value, 1.0, factor, 0.25, 4.0) for value in cdl["power"]]
    if "saturation" in cdl:
        cdl["saturation"] = _scaled(cdl["saturation"], 1.0, factor, 0.0, 2.0)
    if "saturation" in look:
        look["saturation"] = _scaled(look["saturation"], 1.0, factor, 0.0, 2.0)
    if "vibrance" in look:
        look["vibrance"] = _scaled(look["vibrance"], 0.0, factor, -1.0, 2.0)
    split_tone = look.get("split_tone", {})
    if "strength" in split_tone:
        split_tone["strength"] = _scaled(split_tone["strength"], 0.0, factor, 0.0, 0.25)
    for hue_range in look.get("hue_ranges", []):
        if "hue_shift_degrees" in hue_range:
            hue_range["hue_shift_degrees"] = _scaled(
                hue_range["hue_shift_degrees"], 0.0, factor, -180.0, 180.0
            )
        if "saturation_scale" in hue_range:
            hue_range["saturation_scale"] = _scaled(
                hue_range["saturation_scale"], 1.0, factor, 0.0, 2.0
            )
        if "luminance_scale" in hue_range:
            hue_range["luminance_scale"] = _scaled(
                hue_range["luminance_scale"], 1.0, factor, 0.25, 2.0
            )
        if "strength" in hue_range:
            hue_range["strength"] = _scaled(hue_range["strength"], 0.0, factor, 0.0, 1.0)
    recipe["intent"] = (
        f"{base_recipe.get('intent', 'Creative grade')}; automatically derived {intensity} "
        "creative intensity with correction, protection, and effect permission unchanged; "
        "transformative-only warning tolerance disabled outside transformative"
    )
    validate_recipe(recipe)
    return recipe


def write_intensity_recipes(base_recipe_path: Path, output_dir: Path) -> list[tuple[str, Path]]:
    base_recipe = load_recipe(base_recipe_path)
    recipe_dir = output_dir / "derived-recipes"
    recipe_dir.mkdir(parents=True, exist_ok=True)
    variants = []
    for intensity in ("conservative", "standard", "bold", "transformative"):
        recipe = derive_intensity_recipe(base_recipe, intensity)
        path = recipe_dir / f"{intensity}.json"
        path.write_text(json.dumps(recipe, indent=2), encoding="utf-8")
        variants.append((intensity.title(), path))
    return variants


def _slug(label: str, index: int) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", label.casefold()).strip("-")
    return value or f"variant-{index + 1}"


def _display_image(rgb: np.ndarray) -> Image.Image:
    pixels = np.uint8(np.clip(np.round(rgb * 255.0), 0, 255))
    return Image.fromarray(pixels, mode="RGB")


def build_contact_sheet(
    panels: list[tuple[str, np.ndarray]],
    output: Path,
    columns: int = 2,
) -> None:
    if not panels:
        raise ValueError("at least one panel is required")
    if not 1 <= columns <= 4:
        raise ValueError("columns must be in [1, 4]")
    images = [(label, _display_image(rgb)) for label, rgb in panels]
    tile_width = max(image.width for _, image in images)
    tile_height = max(image.height for _, image in images)
    header_height = 38
    padding = 16
    rows = (len(images) + columns - 1) // columns
    sheet = Image.new(
        "RGB",
        (
            columns * tile_width + (columns + 1) * padding,
            rows * (tile_height + header_height) + (rows + 1) * padding,
        ),
        (24, 24, 24),
    )
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, (label, image) in enumerate(images):
        row, column = divmod(index, columns)
        x = padding + column * (tile_width + padding)
        y = padding + row * (tile_height + header_height + padding)
        draw.text((x + 4, y + 10), label, fill=(245, 245, 245), font=font)
        image_x = x + (tile_width - image.width) // 2
        image_y = y + header_height + (tile_height - image.height) // 2
        sheet.paste(image, (image_x, image_y))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", compress_level=6)


def render_variants(
    input_path: Path,
    variants: list[tuple[str, Path]],
    output_dir: Path,
    max_size: int = 1200,
    columns: int = 2,
) -> dict[str, Any]:
    if len(variants) < 2:
        raise ValueError("at least two variants are required for comparison")
    if max_size < 64:
        raise ValueError("max_size must be at least 64")
    labels = [label.casefold() for label, _ in variants]
    if len(set(labels)) != len(labels):
        raise ValueError("variant labels must be unique")

    source_hash_before = sha256_file(input_path)
    source, alpha, metadata = load_image(input_path, max_size=max_size)
    output_dir.mkdir(parents=True, exist_ok=True)
    panels: list[tuple[str, np.ndarray]] = [("Original", source)]
    records = []
    used_slugs: set[str] = set()
    for index, (label, recipe_path) in enumerate(variants):
        recipe = load_recipe(recipe_path)
        slug = _slug(label, index)
        if slug in used_slugs:
            slug = f"{slug}-{index + 1}"
        used_slugs.add(slug)
        extension = ".jpg" if recipe["output"].get("format") == "jpeg" else ".png"
        output_path = output_dir / f"{input_path.stem}--{slug}{extension}"
        if output_path.resolve() == input_path.resolve():
            raise RecipeError("variant output must not overwrite the input")
        result, diagnostics = render_array(source, recipe)
        save_image(output_path, result, alpha, recipe, metadata)
        recipe_copy = output_path.with_suffix(output_path.suffix + ".recipe.json")
        shutil.copyfile(recipe_path, recipe_copy)
        difference = difference_metrics(source, result)
        records.append({
            "label": label,
            "intensity": recipe.get("strategy", {}).get("intensity"),
            "style": recipe.get("strategy", {}).get("style"),
            "recipe": str(recipe_path.resolve()),
            "recipe_copy": str(recipe_copy.resolve()),
            "output": str(output_path.resolve()),
            "output_sha256": sha256_file(output_path),
            "difference": difference,
            "intent_warnings": strategy_warnings(recipe, difference),
            "diagnostics": diagnostics,
        })
        panels.append((label, result))

    source_hash_after = sha256_file(input_path)
    if source_hash_before != source_hash_after:
        raise RuntimeError("source file changed during variant rendering")
    sheet_path = output_dir / f"{input_path.stem}--comparison.png"
    build_contact_sheet(panels, sheet_path, columns=columns)
    manifest = {
        "schema_version": "1.0",
        "input": str(input_path.resolve()),
        "input_sha256": source_hash_before,
        "preview_max_size": max_size,
        "comparison_sheet": str(sheet_path.resolve()),
        "variants": records,
    }
    manifest_path = output_dir / f"{input_path.stem}--variants.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    manifest["manifest"] = str(manifest_path.resolve())
    return manifest


def _variant_argument(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("variant must use LABEL=RECIPE.json")
    label, recipe = value.split("=", 1)
    if not label.strip() or not recipe.strip():
        raise argparse.ArgumentTypeError("variant must use non-empty LABEL=RECIPE.json")
    return label.strip(), Path(recipe.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description="Render labeled color-grade alternatives and a contact sheet.")
    parser.add_argument("input", type=Path)
    recipes = parser.add_mutually_exclusive_group(required=True)
    recipes.add_argument("--variant", action="append", type=_variant_argument)
    recipes.add_argument("--base-recipe", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--max-size", type=int, default=1200)
    parser.add_argument("--columns", type=int, default=2)
    args = parser.parse_args()
    try:
        selected = (
            write_intensity_recipes(args.base_recipe, args.output_dir)
            if args.base_recipe else args.variant
        )
        manifest = render_variants(args.input, selected, args.output_dir, args.max_size, args.columns)
    except (RecipeError, OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"error: {error}\n")
    print(manifest["comparison_sheet"])
    print(manifest["manifest"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
