#!/usr/bin/env python3
"""Generates HappyIcons' Seti file icons from @peoplesgrocers/seti-ui-file-icons.

    scripts/generate-file-icons.py [path/to/@peoplesgrocers/seti-ui-file-icons] [--check]

happy-app's FileIcon draws the package's SVGs with react-native-svg, filled
with a colour from its own light or dark Seti theme. This app draws no SVG at
runtime, so this script reads the package's icons.json and definitions.json
and writes Sources/HappyIcons/GeneratedFileIcons.swift: every icon as plain
outlines VectorPath can parse (m, l, q, c and z), and the name-to-icon rules.

- The package path defaults to the repo's node_modules. Its version must be
  the one happy-app locks (pnpm-lock.yaml).
- What the SVGs use beyond plain paths is resolved here, the way
  react-native-svg draws them under `<SvgXml fill={color}>`: arcs, smooth
  curves, circles and ellipses become cubic curves; `translate` transforms
  are applied; `<use>` is replaced by what it names; `fill-rule` and
  `opacity` are kept per shape. Gradients and `<style>` rules are defined
  but never referenced by any shape, and strokes have no colour, so none of
  them draw; the script fails if that ever changes.
- --check regenerates in memory twice and fails if the two runs differ or if
  the file on disk is stale. It writes nothing.

The outlines were checked by drawing every icon twice with Skia (CanvasKit):
the package's own SVG shapes, and the generated paths. At 128px, 12 of 151
icons differ anywhere by more than a quarter of a pixel's coverage, in at
most 12 edge pixels; with the rounding turned off, one pixel in 1024px
renders of all of them.

No dependencies beyond the standard library.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGE_DIR.parent.parent
OUTPUT_SWIFT = PACKAGE_DIR / "Sources" / "HappyIcons" / "GeneratedFileIcons.swift"
LOCKED_VERSION = "1.11.3"
PACKAGE_NAME = "@peoplesgrocers/seti-ui-file-icons"

# Neither project's LICENSE file ships in node_modules, so the notices are
# written from the published licenses: seti-ui's LICENSE.md and the
# package's package.json. Check them against upstream before release.
NOTICES = """Seti UI icons, https://github.com/jesseweed/seti-ui
Copyright (c) 2014 Jesse Weed
License: MIT (below).

@peoplesgrocers/seti-ui-file-icons 1.11.3, which packages them,
https://github.com/peoplesgrocers/seti-ui-file-icons
License: MIT (package.json; author Karl Marx).

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""

COLORS = {"blue", "grey", "grey-light", "green", "orange", "pink", "purple", "red", "white", "yellow", "ignore"}


class IconError(Exception):
    pass


# --------------------------------------------------------------------------
# Path data


Point = tuple[float, float]


@dataclass
class Segment:
    """One absolute outline step: M, L, Q, C or Z."""

    kind: str
    points: list[Point]


NUMBER = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
COMMANDS = "MmLlHhVvCcSsQqTtAaZz"
ARITY = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def tokenize(data: str) -> list[str | float]:
    """Commands as letters, numbers as floats. Arc flags are single digits
    that may run into the next number ("a1 1 0 011 1"), so the parser asks
    for them separately; numbers are kept as their source text until then."""
    tokens: list[str | float] = []
    i = 0
    while i < len(data):
        c = data[i]
        if c in COMMANDS:
            tokens.append(c)
            i += 1
        elif c in " \t\r\n,":
            i += 1
        else:
            match = NUMBER.match(data, i)
            if not match:
                raise IconError(f"unexpected {c!r} in path data at {i}")
            tokens.append(match.group(0))  # type: ignore[arg-type]
            i = match.end()
    return tokens


class PathReader:
    def __init__(self, data: str) -> None:
        self.tokens = tokenize(data)
        self.index = 0

    def done(self) -> bool:
        return self.index >= len(self.tokens)

    def peek_is_number(self) -> bool:
        return not self.done() and self.tokens[self.index] not in tuple(COMMANDS)

    def command(self) -> str:
        token = self.tokens[self.index]
        self.index += 1
        return token  # type: ignore[return-value]

    def number(self) -> float:
        token = self.tokens[self.index]
        self.index += 1
        return float(token)

    def flag(self) -> float:
        """One 0 or 1, splitting it off the front of a run of digits."""
        token = str(self.tokens[self.index])
        if token[0] not in "01":
            raise IconError(f"bad arc flag {token!r}")
        rest = token[1:]
        if rest:
            self.tokens[self.index] = rest
        else:
            self.index += 1
        return float(token[0])


def parse_path(data: str) -> list[Segment]:
    reader = PathReader(data)
    segments: list[Segment] = []
    x = y = 0.0
    start = (0.0, 0.0)
    last_cubic: Point | None = None
    last_quad: Point | None = None
    command: str | None = None
    while not reader.done():
        if not reader.peek_is_number():
            command = reader.command()
        elif command is None:
            raise IconError("path data starts with a number")
        assert command is not None
        upper = command.upper()
        relative = command != upper
        if upper == "Z":
            segments.append(Segment("Z", []))
            x, y = start
            last_cubic = last_quad = None
            command = None
            continue
        args = []
        for k in range(ARITY[upper]):
            if upper == "A" and k in (3, 4):
                args.append(reader.flag())
            else:
                args.append(reader.number())
        ox, oy = (x, y) if relative else (0.0, 0.0)
        cubic: Point | None = None
        quad: Point | None = None
        if upper == "M":
            x, y = ox + args[0], oy + args[1]
            start = (x, y)
            segments.append(Segment("M", [(x, y)]))
            command = "l" if relative else "L"
        elif upper == "L":
            x, y = ox + args[0], oy + args[1]
            segments.append(Segment("L", [(x, y)]))
        elif upper == "H":
            x = ox + args[0]
            segments.append(Segment("L", [(x, y)]))
        elif upper == "V":
            y = oy + args[0]
            segments.append(Segment("L", [(x, y)]))
        elif upper in ("C", "S"):
            if upper == "C":
                c1 = (ox + args[0], oy + args[1])
                rest = args[2:]
            else:
                c1 = (2 * x - last_cubic[0], 2 * y - last_cubic[1]) if last_cubic else (x, y)
                rest = args
            c2 = (ox + rest[0], oy + rest[1])
            x, y = ox + rest[2], oy + rest[3]
            segments.append(Segment("C", [c1, c2, (x, y)]))
            cubic = c2
        elif upper in ("Q", "T"):
            if upper == "Q":
                control = (ox + args[0], oy + args[1])
                rest = args[2:]
            else:
                control = (2 * x - last_quad[0], 2 * y - last_quad[1]) if last_quad else (x, y)
                rest = args
            x, y = ox + rest[0], oy + rest[1]
            segments.append(Segment("Q", [control, (x, y)]))
            quad = control
        elif upper == "A":
            end = (ox + args[5], oy + args[6])
            segments.extend(arc((x, y), args[0], args[1], args[2], bool(args[3]), bool(args[4]), end))
            x, y = end
        last_cubic, last_quad = cubic, quad
    return segments


def arc(p0: Point, rx: float, ry: float, angle: float, large: bool, sweep: bool, p1: Point) -> list[Segment]:
    """SVG 1.1 implementation notes F.6: endpoint to centre form, then one
    cubic per quarter turn or less."""
    if p0 == p1:
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return [Segment("L", [p1])]
    phi = math.radians(angle % 360)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1 = cos_phi * dx + sin_phi * dy
    y1 = -sin_phi * dx + cos_phi * dy
    scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if scale > 1:
        rx, ry = rx * math.sqrt(scale), ry * math.sqrt(scale)
    numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    factor = math.sqrt(max(0.0, numerator / denominator)) if denominator else 0.0
    if large == sweep:
        factor = -factor
    cx1, cy1 = factor * rx * y1 / ry, -factor * ry * x1 / rx
    cx = cos_phi * cx1 - sin_phi * cy1 + (p0[0] + p1[0]) / 2
    cy = sin_phi * cx1 + cos_phi * cy1 + (p0[1] + p1[1]) / 2

    def angle_between(ux: float, uy: float, vx: float, vy: float) -> float:
        value = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return value

    theta = angle_between(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    delta = angle_between((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    elif sweep and delta < 0:
        delta += 2 * math.pi

    count = max(1, math.ceil(abs(delta) / (math.pi / 2) - 1e-9))
    step = delta / count
    k = 4 / 3 * math.tan(step / 4)

    def point(t: float) -> Point:
        ex, ey = rx * math.cos(t), ry * math.sin(t)
        return (cos_phi * ex - sin_phi * ey + cx, sin_phi * ex + cos_phi * ey + cy)

    def derivative(t: float) -> Point:
        ex, ey = -rx * math.sin(t), ry * math.cos(t)
        return (cos_phi * ex - sin_phi * ey, sin_phi * ex + cos_phi * ey)

    segments = []
    t = theta
    for i in range(count):
        a, b = t, t + step
        pa, pb = point(a), point(b)
        da, db = derivative(a), derivative(b)
        c1 = (pa[0] + k * da[0], pa[1] + k * da[1])
        c2 = (pb[0] - k * db[0], pb[1] - k * db[1])
        end = p1 if i == count - 1 else pb
        segments.append(Segment("C", [c1, c2, end]))
        t = b
    return segments


def ellipse(cx: float, cy: float, rx: float, ry: float) -> list[Segment]:
    """react-native-svg draws a circle or ellipse from its rightmost point,
    clockwise on screen: four quarter arcs."""
    if rx <= 0 or ry <= 0:
        return []
    start = (cx + rx, cy)
    segments = [Segment("M", [start])]
    points = [(cx, cy + ry), (cx - rx, cy), (cx, cy - ry), start]
    current = start
    for p in points:
        segments.extend(arc(current, rx, ry, 0, False, True, p))
        current = p
    segments.append(Segment("Z", []))
    return segments


# --------------------------------------------------------------------------
# SVG documents


@dataclass
class Shape:
    segments: list[Segment]
    even_odd: bool
    opacity: float


@dataclass
class IconOutline:
    view_box: tuple[float, float, float, float]
    shapes: list[Shape]


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def attribute(element: ET.Element, name: str) -> str | None:
    for key, value in element.attrib.items():
        if local(key) == name:
            return value
    return None


TRANSLATE = re.compile(r"^\s*translate\(\s*(" + NUMBER.pattern + r")(?:[\s,]+(" + NUMBER.pattern + r"))?\s*\)\s*$")


def translation(element: ET.Element) -> Point:
    value = attribute(element, "transform")
    if value is None:
        return (0.0, 0.0)
    match = TRANSLATE.match(value)
    if not match:
        raise IconError(f"unsupported transform {value!r}")
    return (float(match.group(1)), float(match.group(2) or 0))


def moved(segments: list[Segment], offset: Point) -> list[Segment]:
    if offset == (0.0, 0.0):
        return segments
    return [Segment(s.kind, [(p[0] + offset[0], p[1] + offset[1]) for p in s.points]) for s in segments]


def parse_icon(name: str, svg: str) -> IconOutline:
    root = ET.fromstring(svg)
    if local(root.tag) != "svg":
        raise IconError(f"{name}: root is not <svg>")
    view_box = attribute(root, "viewBox")
    if view_box is None:
        raise IconError(f"{name}: no viewBox")
    box = tuple(float(v) for v in view_box.replace(",", " ").split())
    if len(box) != 4:
        raise IconError(f"{name}: bad viewBox {view_box!r}")
    aspect = attribute(root, "preserveAspectRatio")
    if aspect not in (None, "xMidYMid", "xMidYMid meet"):
        raise IconError(f"{name}: unsupported preserveAspectRatio {aspect!r}")

    by_id = {attribute(e, "id"): e for e in root.iter() if attribute(e, "id")}
    shapes: list[Shape] = []

    def check_paint(element: ET.Element) -> None:
        # Paint from attributes or classes would override the fill colour.
        for key in ("fill", "stroke", "class", "style", "clip-path", "mask", "filter"):
            if attribute(element, key) is not None:
                raise IconError(f"{name}: <{local(element.tag)} {key}> would change how it draws")

    def visit(element: ET.Element, offset: Point, even_odd: bool, opacity: float, in_defs: bool) -> None:
        tag = local(element.tag)
        if tag in ("linearGradient", "radialGradient", "stop", "style", "title", "desc"):
            return
        check_paint(element)
        rule = attribute(element, "fill-rule")
        if rule is not None:
            even_odd = rule == "evenodd"
        alpha = attribute(element, "opacity")
        if alpha is not None:
            opacity *= float(alpha)
        own = translation(element)
        offset = (offset[0] + own[0], offset[1] + own[1])
        if tag == "defs":
            return
        if tag in ("svg", "g"):
            for child in element:
                visit(child, offset, even_odd, opacity, in_defs)
            return
        if tag == "use":
            target = attribute(element, "href")
            if not target or not target.startswith("#") or target[1:] not in by_id:
                raise IconError(f"{name}: <use> of {target!r}")
            x = float(attribute(element, "x") or 0)
            y = float(attribute(element, "y") or 0)
            visit(by_id[target[1:]], (offset[0] + x, offset[1] + y), even_odd, opacity, in_defs)
            return
        if tag == "path":
            segments = parse_path(attribute(element, "d") or "")
        elif tag == "circle":
            r = float(attribute(element, "r") or 0)
            segments = ellipse(float(attribute(element, "cx") or 0), float(attribute(element, "cy") or 0), r, r)
        elif tag == "ellipse":
            segments = ellipse(float(attribute(element, "cx") or 0), float(attribute(element, "cy") or 0),
                               float(attribute(element, "rx") or 0), float(attribute(element, "ry") or 0))
        else:
            raise IconError(f"{name}: unsupported <{tag}>")
        if segments:
            shapes.append(Shape(moved(segments, offset), even_odd, opacity))

    root_rule = attribute(root, "fill-rule") == "evenodd"
    for child in root:
        visit(child, (0.0, 0.0), root_rule, 1.0, False)
    if not shapes:
        raise IconError(f"{name}: draws nothing")
    return IconOutline(box, shapes)  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# Output


def decimals_for(view_box: tuple[float, float, float, float]) -> int:
    """Enough places that rounding moves a point by at most 1/2000 of the
    icon: under 0.01pt at the sizes happy-app draws."""
    extent = max(view_box[2], view_box[3])
    for places in range(0, 4):
        if 10 ** -places <= extent / 2000:
            return places
    return 3


def number(value: float, places: int) -> str:
    text = f"{round(value, places):.{places}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        text = "0"
    if text.startswith("0."):
        text = text[1:]
    elif text.startswith("-0."):
        text = "-" + text[2:]
    return text


def numbers(values: list[float], places: int) -> str:
    out = ""
    for value in values:
        text = number(value, places)
        if out and not text.startswith("-"):
            out += " "
        out += text
    return out


def encode(segments: list[Segment], places: int) -> str:
    """Relative commands between rounded absolute points, so rounding never
    accumulates. After z the pen is back at the subpath's start, as SVG
    (and VectorPath) has it."""

    def r(p: Point) -> Point:
        return (round(p[0], places), round(p[1], places))

    out = []
    pen = (0.0, 0.0)
    start = (0.0, 0.0)
    previous = None
    for segment in segments:
        points = [r(p) for p in segment.points]
        rel = [v for p in points for v in (p[0] - pen[0], p[1] - pen[1])]
        letter = segment.kind.lower()
        if segment.kind == "Z":
            out.append("z")
            pen = start
            previous = None
            continue
        body = numbers(rel, places)
        # An implicit repeat drops the letter (a move's repeats are lines).
        repeat = previous == letter or (previous == "m" and letter == "l")
        out.append((" " if repeat and not body.startswith("-") else "") + body if repeat else letter + body)
        pen = points[-1]
        if segment.kind == "M":
            start = pen
        previous = letter
    return "".join(out)


def build(package: Path) -> tuple[str, dict[str, int]]:
    meta = json.loads((package / "package.json").read_text(encoding="utf-8"))
    if meta.get("version") != LOCKED_VERSION:
        raise SystemExit(f"{PACKAGE_NAME} is {meta.get('version')}, happy-app locks {LOCKED_VERSION}")
    icons = json.loads((package / "lib" / "icons.json").read_text(encoding="utf-8"))
    definitions = json.loads((package / "lib" / "definitions.json").read_text(encoding="utf-8"))

    def entry(key: str, value: list[str]) -> str:
        icon, color = value
        if icon not in icons:
            raise SystemExit(f"definition {key!r} names missing icon {icon!r}")
        if color not in COLORS:
            raise SystemExit(f"definition {key!r} has unknown colour {color!r}")
        if any(c in key for c in " \n\"\\") or not key:
            raise SystemExit(f"definition key {key!r} can't be written as is")
        return f"{key} {icon} {color}"

    lines = []
    shape_count = 0
    for name in sorted(icons):
        if any(c in name for c in " \n;,"):
            raise SystemExit(f"icon name {name!r} can't be written as is")
        outline = parse_icon(name, icons[name])
        places = decimals_for(outline.view_box)
        shapes = []
        for shape in outline.shapes:
            rule = "e" if shape.even_odd else "n"
            shapes.append(f"{rule},{number(shape.opacity, 3)},{encode(shape.segments, places)}")
            shape_count += 1
        box = ",".join(number(v, 3) for v in outline.view_box)
        lines.append(f"{name} {box} {';'.join(shapes)}")

    files = [entry(k, v) for k, v in definitions["files"].items()]
    extensions = [entry(k, v) for k, v in definitions["extensions"].items()]
    partials = [entry(p[0], p[1]) for p in definitions["partials"]]
    default = definitions["default"]
    if default[1] not in COLORS or default[0] not in icons:
        raise SystemExit(f"bad default {default!r}")

    def block(rows: list[str]) -> str:
        return "\n".join(rows)

    notice = "\n".join(("// " + line).rstrip() for line in NOTICES.splitlines())
    swift = f"""// Generated by scripts/generate-file-icons.py from {PACKAGE_NAME}
// {LOCKED_VERSION}. Do not edit; rerun the script.
//
{notice}

/// The Seti icons and happy-app's lookup rules, as `FileIcons` reads them.
enum GeneratedFileIcons {{
    /// One icon per line: `name minX,minY,width,height shapes`, the shapes
    /// `;`-separated, each `rule,opacity,path`: rule `n` (non-zero) or `e`
    /// (even-odd), path data in m, l, q, c and z.
    static let icons = \"\"\"
{block(lines)}
\"\"\"

    /// `definitions.files`: an exact file name, its icon and colour.
    static let files = \"\"\"
{block(files)}
\"\"\"

    /// `definitions.extensions`, the same way.
    static let extensions = \"\"\"
{block(extensions)}
\"\"\"

    /// `definitions.partials`, in order: the first one a name contains wins.
    static let partials = \"\"\"
{block(partials)}
\"\"\"

    static let defaultIcon = "{default[0]}"
    static let defaultColor = "{default[1]}"
}}
"""
    counts = {"icons": len(lines), "shapes": shape_count, "files": len(files), "extensions": len(extensions), "partials": len(partials)}
    return swift, counts


def default_package() -> Path:
    return REPO_ROOT / "node_modules" / "@peoplesgrocers" / "seti-ui-file-icons"


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
    except IconError as error:
        raise SystemExit(str(error))
    print(", ".join(f"{k} {v}" for k, v in counts.items()))
    if args.check:
        again, _ = build(package)
        if again != swift:
            raise SystemExit("not deterministic: two runs produced different output")
        if not OUTPUT_SWIFT.exists() or OUTPUT_SWIFT.read_text(encoding="utf-8") != swift:
            raise SystemExit(f"stale, rerun scripts/generate-file-icons.py: {OUTPUT_SWIFT}")
        print("up to date, and two runs match")
        return
    OUTPUT_SWIFT.write_text(swift, encoding="utf-8")
    print(f"wrote {OUTPUT_SWIFT.relative_to(REPO_ROOT)} ({len(swift.encode())} bytes)")


if __name__ == "__main__":
    main()
