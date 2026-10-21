#!/usr/bin/env python3
"""Generates the bot faces' artwork from @dicebear/styles' Adventurer Neutral.

    scripts/generate-bot-faces.py [path/to/@dicebear/styles] [--check]

happy-app draws a new bot's face with DiceBear (utils/botFace.ts): the style
definition `src/adventurer-neutral.json` picked through by a seed, rendered
as SVG and painted with Skia. This app draws no SVG at runtime, so this
script reads the definition and writes Sources/HappyLayout/GeneratedBotFaces.swift:
the canvas, the background colours, and every variant of every component as
plain outlines VectorPath can parse (m, l, q, c and z) with its resolved
fill. `BotFace` (Sources/HappyLayout/BotFace.swift) does the picking.

- The package path defaults to the repo's node_modules. Its version must be
  the one happy-app locks.
- Arcs and ellipses become cubic curves with generate-file-icons.py's
  helpers, drawn the way react-native-svg and Skia draw them. The canvas's
  `translate` on each component is applied here.
- The style's root is `fill="none"`, so a shape draws only with a fill of
  its own or its group's. Every colour but the background has one value in
  this style, so fills are written as that value; the script fails if that
  ever changes, or if anything appears that it doesn't draw (strokes,
  transforms inside a variant, clip paths, masks, opacity, gradients).
- --check regenerates in memory twice and fails if the two runs differ or if
  the file on disk is stale. It writes nothing.

No dependencies beyond the standard library.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGE_DIR.parent.parent
OUTPUT_SWIFT = PACKAGE_DIR / "Sources" / "HappyLayout" / "GeneratedBotFaces.swift"
LOCKED_VERSION = "10.6.0"
PACKAGE_NAME = "@dicebear/styles"
STYLE_FILE = "src/adventurer-neutral.json"
# Two places: the source's own precision, so only arcs are approximated.
PLACES = 2

_spec = importlib.util.spec_from_file_location("file_icons", PACKAGE_DIR / "scripts" / "generate-file-icons.py")
assert _spec and _spec.loader
icons = importlib.util.module_from_spec(_spec)
sys.modules["file_icons"] = icons
_spec.loader.exec_module(icons)


class FaceError(Exception):
    pass


TRANSLATE = re.compile(r"^\s*translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)\s*$")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
NAMED = {"white": "#ffffff", "black": "#000000"}


def hex_colour(value: str) -> str:
    value = NAMED.get(value, value)
    if not HEX.match(value):
        raise FaceError(f"unsupported colour {value!r}")
    return value.lower()


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def build(package: Path) -> tuple[str, dict[str, int]]:
    meta = json.loads((package / "package.json").read_text(encoding="utf-8"))
    if meta.get("version") != LOCKED_VERSION:
        raise SystemExit(f"{PACKAGE_NAME} is {meta.get('version')}, happy-app locks {LOCKED_VERSION}")
    style = json.loads((package / STYLE_FILE).read_text(encoding="utf-8"))

    colours: dict[str, str] = {}
    for name, colour in style["colors"].items():
        if colour.get("contrastTo") or colour.get("notEqualTo"):
            raise FaceError(f"colour {name!r} depends on another")
        if name == "background":
            continue
        values = colour["values"]
        if len(values) != 1:
            raise FaceError(f"colour {name!r} has {len(values)} values; BotFace resolves only the background")
        colours[name] = hex_colour(values[0])
    background = [hex_colour(v) for v in style["colors"]["background"]["values"]]

    attributes = style.get("attributes", {})
    if attributes.get("fill") != "none" or set(attributes) - {"fill", "shape-rendering"}:
        raise FaceError(f"unexpected root attributes {attributes!r}")
    canvas = style["canvas"]

    def fill_of(value: object) -> str | None:
        if value is None:
            return None
        if isinstance(value, dict):
            if value.get("type") != "color" or value.get("name") not in colours:
                raise FaceError(f"unsupported fill {value!r}")
            return colours[value["name"]]
        if value == "none":
            return "none"
        return hex_colour(str(value))

    shape_count = 0

    def shapes(elements: list[dict], offset: tuple[float, float], fill: str | None, even_odd: bool, where: str) -> list[str]:
        nonlocal shape_count
        out = []
        for element in elements:
            if element.get("type") != "element":
                raise FaceError(f"{where}: unsupported {element.get('type')!r}")
            tag = element.get("name")
            attrs = element.get("attributes", {})
            unknown = set(attrs) - {"d", "fill", "fill-rule", "clip-rule", "cx", "cy", "rx", "ry"}
            if unknown:
                raise FaceError(f"{where}: <{tag}> has {sorted(unknown)}")
            own_fill = fill_of(attrs.get("fill")) or fill
            rule = attrs.get("fill-rule")
            own_even_odd = (rule == "evenodd") if rule is not None else even_odd
            if tag == "g":
                out += shapes(element.get("children", []), offset, own_fill, own_even_odd, where)
                continue
            if element.get("children"):
                raise FaceError(f"{where}: <{tag}> has children")
            if tag == "path":
                segments = icons.parse_path(attrs.get("d", ""))
            elif tag == "ellipse":
                segments = icons.ellipse(float(attrs.get("cx", 0)), float(attrs.get("cy", 0)),
                                         float(attrs.get("rx", 0)), float(attrs.get("ry", 0)))
            else:
                raise FaceError(f"{where}: unsupported <{tag}>")
            if own_fill in (None, "none") or not segments:
                continue  # Drawn with the root's fill="none": nothing.
            rule_letter = "e" if own_even_odd else "n"
            out.append(f"{own_fill[1:]},{rule_letter},{icons.encode(icons.moved(segments, offset), PLACES)}")
            shape_count += 1
        return out

    lines = [
        f"canvas {icons.number(canvas['width'], 3)} {icons.number(canvas['height'], 3)}",
        f"background {' '.join(c[1:] for c in background)}",
    ]
    variant_count = 0
    for element in canvas["elements"]:
        if element.get("type") != "component":
            raise FaceError(f"canvas: unsupported {element.get('type')!r}")
        name = element["name"]
        transform = element.get("attributes", {}).get("transform", "translate(0 0)")
        match = TRANSLATE.match(transform)
        if not match or set(element.get("attributes", {})) - {"transform"}:
            raise FaceError(f"canvas {name}: unsupported attributes {element.get('attributes')!r}")
        offset = (float(match.group(1)), float(match.group(2)))
        component = style["components"][name]
        unknown = set(component) - {"width", "height", "probability", "variants"}
        if unknown:
            raise FaceError(f"component {name}: {sorted(unknown)} would change the picking")
        probability = component.get("probability", 100)
        lines.append(f"component {name} {icons.number(probability, 3)}")
        for variant_name, variant in component["variants"].items():
            if set(variant) - {"elements", "weight"}:
                raise FaceError(f"{name}/{variant_name}: {sorted(set(variant) - {'elements', 'weight'})}")
            weight = variant.get("weight", 1)
            body = shapes(variant["elements"], offset, None, False, f"{name}/{variant_name}")
            lines.append(f"variant {variant_name} {icons.number(weight, 3)} {';'.join(body)}")
            variant_count += 1

    creator = style["meta"]["creator"]
    source = style["meta"]["source"]
    licence = style["meta"]["license"]
    table = "\n".join(lines)
    checksum = fnv1a64(table.encode())
    indented = "\n".join("        " + line for line in lines)

    def literal(text: str) -> str:
        return json.dumps(text, ensure_ascii=False)

    swift = f"""// Generated by scripts/generate-bot-faces.py from {PACKAGE_NAME} {LOCKED_VERSION}
// ({STYLE_FILE}). Do not edit; rerun the script.
//
// {licence['text']}
//
// The table, one line each: `canvas width height`, `background` and its
// colours, then each component in drawing order (`component name
// probability`) followed by its variants (`variant name weight shapes`).
// A shape is `rrggbb,rule,path`: its fill, n for nonzero or e for evenodd,
// and outline data in canvas units with the component's place applied.
// Shapes are separated by `;`.

extension BotFaceStyle {{
    /// Who drew the faces; the picker credits her (`botFaceCredit`).
    public static let adventurerNeutralCredit = Credit(
        pack: {literal(source['name'])},
        artist: {literal(creator['name'])},
        artistURL: {literal(creator['url'])}
    )

    /// FNV-1a 64 of the table as the generator wrote it. A hand edit, or
    /// a generator that stopped being deterministic, breaks the match.
    static let adventurerNeutralChecksum: UInt64 = 0x{checksum:016X}

    static let adventurerNeutralTable = \"\"\"
{indented}
        \"\"\"
}}
"""
    counts = {"components": len(canvas["elements"]), "variants": variant_count, "shapes": shape_count}
    return swift, counts


def default_package() -> Path:
    return REPO_ROOT / "node_modules" / "@dicebear" / "styles"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("package", nargs="?", type=Path, default=None,
                        help=f"path to {PACKAGE_NAME} (default: the repo's node_modules)")
    parser.add_argument("--check", action="store_true",
                        help="regenerate in memory; fail if not deterministic or the file is stale")
    args = parser.parse_args()
    package = args.package or default_package()
    if not (package / "package.json").exists():
        raise SystemExit(f"no {PACKAGE_NAME} at {package}; pass its path")
    try:
        swift, counts = build(package)
    except FaceError as error:
        raise SystemExit(str(error))
    print(", ".join(f"{k} {v}" for k, v in counts.items()))
    if args.check:
        again, _ = build(package)
        if again != swift:
            raise SystemExit("not deterministic: two runs produced different output")
        if not OUTPUT_SWIFT.exists() or OUTPUT_SWIFT.read_text(encoding="utf-8") != swift:
            raise SystemExit(f"stale, rerun scripts/generate-bot-faces.py: {OUTPUT_SWIFT}")
        print("up to date, and two runs match")
        return
    OUTPUT_SWIFT.write_text(swift, encoding="utf-8")
    print(f"wrote {OUTPUT_SWIFT.relative_to(REPO_ROOT)} ({len(swift.encode())} bytes)")


if __name__ == "__main__":
    main()
