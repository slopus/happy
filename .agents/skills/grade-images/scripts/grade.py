# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from grade_core import (
    RecipeError,
    load_image,
    load_recipe,
    render_array,
    save_image,
    sha256_file,
)


def validate_command(recipe_path: Path) -> int:
    load_recipe(recipe_path)
    print(f"valid: {recipe_path}")
    return 0


def render_command(input_path: Path, recipe_path: Path, output_path: Path, max_size: int | None) -> int:
    if input_path.resolve() == output_path.resolve():
        raise RecipeError("output must not overwrite the input")
    source_hash_before = sha256_file(input_path)
    recipe = load_recipe(recipe_path)
    rgb, alpha, metadata = load_image(input_path, max_size=max_size)
    result, diagnostics = render_array(rgb, recipe)
    save_image(output_path, result, alpha, recipe, metadata)
    source_hash_after = sha256_file(input_path)
    if source_hash_before != source_hash_after:
        output_path.unlink(missing_ok=True)
        raise RuntimeError("source file changed during rendering")

    recipe_copy = output_path.with_suffix(output_path.suffix + ".recipe.json")
    shutil.copyfile(recipe_path, recipe_copy)
    manifest = {
        "schema_version": "1.0",
        "input": str(input_path.resolve()),
        "input_sha256": source_hash_before,
        "output": str(output_path.resolve()),
        "output_sha256": sha256_file(output_path),
        "preview": max_size is not None,
        "source_width": metadata["source_size"][0],
        "source_height": metadata["source_size"][1],
        "output_width": int(result.shape[1]),
        "output_height": int(result.shape[0]),
        "has_alpha": alpha is not None,
        "color_management": metadata["color_management"],
        "warnings": metadata["warnings"],
        "diagnostics": diagnostics,
    }
    manifest_path = output_path.with_suffix(output_path.suffix + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(output_path)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate and render strict photo color-grade recipes.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("recipe", type=Path)
    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("input", type=Path)
    render_parser.add_argument("--recipe", required=True, type=Path)
    render_parser.add_argument("--output", required=True, type=Path)
    render_parser.add_argument("--max-size", type=int)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            return validate_command(args.recipe)
        return render_command(args.input, args.recipe, args.output, args.max_size)
    except (RecipeError, OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"error: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
