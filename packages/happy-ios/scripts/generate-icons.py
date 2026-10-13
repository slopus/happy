#!/usr/bin/env python3
"""Generates HappyIcons' vector outlines from @expo/vector-icons' fonts.

    scripts/generate-icons.py [path/to/@expo/vector-icons] [--check]

happy-app draws icons as glyphs of the icon fonts @expo/vector-icons ships.
This app has no icon fonts at runtime (AGENTS.md rule 6), so this script reads
the fonts and writes the outlines of every icon happy-app names into
Sources/HappyIcons/GeneratedIcons.swift, with each font's license notice in
Sources/HappyIcons/LICENSES.md.

- The package path defaults to the repo's node_modules/@expo/vector-icons.
  Its version must be the one happy-app locks (pnpm-lock.yaml).
- Which icons: scanned from packages/happy-app/sources, plus the names in
  scripts/icons-extra.txt that only exist at runtime. Call sites whose names
  the scan can't follow are printed; read them and add what they produce to
  icons-extra.txt.
- --check regenerates in memory twice and fails if the two runs differ or if
  the files on disk are stale. It writes nothing.

No dependencies: the TrueType reader below covers what icon fonts use
(head, hhea, hmtx, maxp, loca, glyf with simple and composite glyphs, cmap
formats 4 and 12, name). The fonts themselves are never copied into the repo.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGE_DIR.parent.parent
APP_SOURCES = REPO_ROOT / "packages" / "happy-app" / "sources"
OUTPUT_SWIFT = PACKAGE_DIR / "Sources" / "HappyIcons" / "GeneratedIcons.swift"
OUTPUT_LICENSES = PACKAGE_DIR / "Sources" / "HappyIcons" / "LICENSES.md"
EXTRA_NAMES = PACKAGE_DIR / "scripts" / "icons-extra.txt"
LOCKED_VERSION = "15.0.3"


@dataclass(frozen=True)
class Family:
    """One icon component of @expo/vector-icons, as happy-app imports it."""

    component: str  # the JSX name, and IconFamily's raw value
    case: str  # the Swift IconFamily case
    font: str  # file in Fonts/
    glyphmap: str  # file in glyphmaps/
    notice: str  # the upstream project's copyright and license, for LICENSES.md


# The fonts' own name tables mostly carry no copyright (only MaterialIcons
# does), so each upstream project's notice is kept here. These were written
# from the projects' published licenses, not copied from their LICENSE files
# (none ship in node_modules); check them against upstream before release.
FAMILIES = [
    Family("Ionicons", "ionicons", "Ionicons.ttf", "Ionicons.json",
           "Ionicons, https://github.com/ionic-team/ionicons\n"
           "Copyright (c) 2015-present Ionic (http://ionic.io/)\n"
           "License: MIT (below)."),
    Family("Octicons", "octicons", "Octicons.ttf", "Octicons.json",
           "Octicons, https://github.com/primer/octicons\n"
           "Copyright (c) GitHub Inc.\n"
           "License: MIT (below)."),
    Family("MaterialCommunityIcons", "materialCommunityIcons", "MaterialCommunityIcons.ttf",
           "MaterialCommunityIcons.json",
           "Material Design Icons, https://github.com/Templarian/MaterialDesign\n"
           "Copyright (c) 2014 Austin Andrews (http://materialdesignicons.com/), and the\n"
           "Pictogrammers contributors; icons derived from Material Design icons are\n"
           "Copyright (c) 2014 Google.\n"
           "License: Pictogrammers Free License. The icons are under the Apache License,\n"
           "Version 2.0 (below); the font is under the SIL Open Font License 1.1."),
    Family("MaterialIcons", "materialIcons", "MaterialIcons.ttf", "MaterialIcons.json",
           "Material Icons, https://github.com/google/material-design-icons\n"
           "Copyright Google LLC.\n"
           "License: Apache License, Version 2.0 (below)."),
    Family("Feather", "feather", "Feather.ttf", "Feather.json",
           "Feather, https://github.com/feathericons/feather\n"
           "Copyright (c) 2013-2017 Cole Bemis\n"
           "License: MIT (below)."),
    Family("FontAwesome", "fontAwesome", "FontAwesome.ttf", "FontAwesome.json",
           "Font Awesome 4.7, https://fontawesome.com/v4\n"
           "Copyright Dave Gandy.\n"
           "License: the font is under the SIL Open Font License 1.1."),
    # FontAwesome5 picks a font per style prop (solid, brand); without one RN
    # draws the Regular face, so that is the face read here.
    Family("FontAwesome5", "fontAwesome5", "FontAwesome5_Regular.ttf", "FontAwesome5Free.json",
           "Font Awesome 5 Free, https://fontawesome.com\n"
           "Copyright Fonticons, Inc.\n"
           "License: icons under CC BY 4.0, the font under the SIL Open Font License 1.1."),
]

MIT_TEXT = """Permission is hereby granted, free of charge, to any person obtaining a copy
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

APACHE_TEXT = """Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License."""

FAMILY_BY_COMPONENT = {f.component: f for f in FAMILIES}


# --------------------------------------------------------------------------
# TrueType reader


class FontError(Exception):
    pass


@dataclass
class Glyph:
    advance: int
    bbox: tuple[int, int, int, int]  # xMin, yMin, xMax, yMax, y up
    contours: list[list[tuple[int, int, bool]]]  # (x, y, on curve), y up


class TrueTypeFont:
    def __init__(self, data: bytes, name: str):
        self.data = data
        self.name = name
        version, count = struct.unpack_from(">IH", data, 0)
        if version not in (0x00010000, 0x74727565):
            raise FontError(f"{name}: not a TrueType font (sfnt version {version:#x}); CFF needs fontTools")
        self.tables: dict[str, tuple[int, int]] = {}
        for i in range(count):
            tag, _, offset, length = struct.unpack_from(">4sIII", data, 12 + 16 * i)
            self.tables[tag.decode("latin-1")] = (offset, length)
        if "glyf" not in self.tables:
            raise FontError(f"{name}: no glyf table (CFF outlines need fontTools)")
        head = self.table("head")
        self.units_per_em = struct.unpack_from(">H", head, 18)[0]
        self.index_to_loc_format = struct.unpack_from(">h", head, 50)[0]
        hhea = self.table("hhea")
        self.ascender, self.descender, self.line_gap = struct.unpack_from(">hhh", hhea, 4)
        self.number_of_hmetrics = struct.unpack_from(">H", hhea, 34)[0]
        self.num_glyphs = struct.unpack_from(">H", self.table("maxp"), 4)[0]
        self._read_hmtx()
        self._read_loca()
        self.cmap = self._read_cmap()
        self.names = self._read_names()

    def table(self, tag: str) -> bytes:
        if tag not in self.tables:
            raise FontError(f"{self.name}: missing {tag} table")
        offset, length = self.tables[tag]
        return self.data[offset:offset + length]

    def _read_hmtx(self) -> None:
        hmtx = self.table("hmtx")
        self.advances = []
        for i in range(self.number_of_hmetrics):
            self.advances.append(struct.unpack_from(">H", hmtx, 4 * i)[0])
        # Glyphs past numberOfHMetrics repeat the last advance.
        self.advances += [self.advances[-1]] * (self.num_glyphs - self.number_of_hmetrics)

    def _read_loca(self) -> None:
        loca = self.table("loca")
        if self.index_to_loc_format == 0:
            self.loca = [2 * v for v in struct.unpack_from(f">{self.num_glyphs + 1}H", loca, 0)]
        else:
            self.loca = list(struct.unpack_from(f">{self.num_glyphs + 1}I", loca, 0))

    def _read_cmap(self) -> dict[int, int]:
        cmap = self.table("cmap")
        _, count = struct.unpack_from(">HH", cmap, 0)
        subtables = {}
        for i in range(count):
            platform, encoding, offset = struct.unpack_from(">HHI", cmap, 4 + 8 * i)
            subtables[(platform, encoding)] = offset
        # Full Unicode first: MaterialCommunityIcons lives past U+FFFF.
        for key in [(3, 10), (0, 6), (0, 4), (3, 1), (0, 3), (0, 1), (0, 0)]:
            if key in subtables:
                return self._read_cmap_subtable(cmap, subtables[key])
        raise FontError(f"{self.name}: no Unicode cmap")

    def _read_cmap_subtable(self, cmap: bytes, offset: int) -> dict[int, int]:
        fmt = struct.unpack_from(">H", cmap, offset)[0]
        mapping: dict[int, int] = {}
        if fmt == 4:
            seg_count = struct.unpack_from(">H", cmap, offset + 6)[0] // 2
            ends = struct.unpack_from(f">{seg_count}H", cmap, offset + 14)
            starts_at = offset + 16 + 2 * seg_count
            starts = struct.unpack_from(f">{seg_count}H", cmap, starts_at)
            deltas = struct.unpack_from(f">{seg_count}h", cmap, starts_at + 2 * seg_count)
            range_offsets_at = starts_at + 4 * seg_count
            range_offsets = struct.unpack_from(f">{seg_count}H", cmap, range_offsets_at)
            for i in range(seg_count):
                for code in range(starts[i], ends[i] + 1):
                    if code == 0xFFFF:
                        continue
                    if range_offsets[i] == 0:
                        gid = (code + deltas[i]) & 0xFFFF
                    else:
                        at = range_offsets_at + 2 * i + range_offsets[i] + 2 * (code - starts[i])
                        gid = struct.unpack_from(">H", cmap, at)[0]
                        if gid:
                            gid = (gid + deltas[i]) & 0xFFFF
                    if gid:
                        mapping[code] = gid
        elif fmt == 12:
            groups = struct.unpack_from(">I", cmap, offset + 12)[0]
            for i in range(groups):
                start, end, gid = struct.unpack_from(">III", cmap, offset + 16 + 12 * i)
                for code in range(start, end + 1):
                    mapping[code] = gid + code - start
        else:
            raise FontError(f"{self.name}: cmap format {fmt} is not supported")
        return mapping

    def _read_names(self) -> dict[int, str]:
        table = self.table("name")
        _, count, string_offset = struct.unpack_from(">HHH", table, 0)
        found: dict[int, tuple[int, str]] = {}
        for i in range(count):
            platform, encoding, language, name_id, length, offset = struct.unpack_from(">6H", table, 6 + 12 * i)
            raw = table[string_offset + offset:string_offset + offset + length]
            if platform == 3 or platform == 0:
                text, rank = raw.decode("utf-16-be"), 0 if language in (0x409, 0) else 1
            elif platform == 1 and encoding == 0:
                text, rank = raw.decode("mac_roman"), 2
            else:
                continue
            if name_id not in found or rank < found[name_id][0]:
                found[name_id] = (rank, text.strip())
        return {k: v for k, (_, v) in found.items()}

    def glyph(self, gid: int, depth: int = 0) -> Glyph:
        if depth > 8:
            raise FontError(f"{self.name}: composite glyph nesting too deep")
        glyf = self.table("glyf")
        start, end = self.loca[gid], self.loca[gid + 1]
        if start == end:
            return Glyph(self.advances[gid], (0, 0, 0, 0), [])
        n_contours, x_min, y_min, x_max, y_max = struct.unpack_from(">hhhhh", glyf, start)
        if n_contours >= 0:
            contours = self._simple_glyph(glyf, start + 10, n_contours)
        else:
            contours = self._composite_glyph(glyf, start + 10, depth)
        return Glyph(self.advances[gid], (x_min, y_min, x_max, y_max), contours)

    @staticmethod
    def _simple_glyph(glyf: bytes, at: int, n_contours: int) -> list[list[tuple[int, int, bool]]]:
        ends = struct.unpack_from(f">{n_contours}H", glyf, at)
        at += 2 * n_contours
        count = ends[-1] + 1 if ends else 0
        instruction_length = struct.unpack_from(">H", glyf, at)[0]
        at += 2 + instruction_length
        flags: list[int] = []
        while len(flags) < count:
            flag = glyf[at]
            at += 1
            flags.append(flag)
            if flag & 0x08:  # REPEAT_FLAG
                repeat = glyf[at]
                at += 1
                flags += [flag] * repeat

        def coordinates(short_bit: int, same_bit: int) -> list[int]:
            nonlocal at
            values, value = [], 0
            for flag in flags:
                if flag & short_bit:
                    delta = glyf[at]
                    at += 1
                    value += delta if flag & same_bit else -delta
                elif not flag & same_bit:
                    value += struct.unpack_from(">h", glyf, at)[0]
                    at += 2
                values.append(value)
            return values

        xs = coordinates(0x02, 0x10)
        ys = coordinates(0x04, 0x20)
        contours, first = [], 0
        for end in ends:
            contours.append([(xs[i], ys[i], bool(flags[i] & 0x01)) for i in range(first, end + 1)])
            first = end + 1
        return contours

    def _composite_glyph(self, glyf: bytes, at: int, depth: int) -> list[list[tuple[int, int, bool]]]:
        contours = []
        while True:
            flags, gid = struct.unpack_from(">HH", glyf, at)
            at += 4
            if not flags & 0x0002:  # ARGS_ARE_XY_VALUES
                raise FontError(f"{self.name}: composite glyphs that match points are not supported")
            if flags & 0x0001:  # ARG_1_AND_2_ARE_WORDS
                dx, dy = struct.unpack_from(">hh", glyf, at)
                at += 4
            else:
                dx, dy = struct.unpack_from(">bb", glyf, at)
                at += 2
            if flags & (0x0008 | 0x0040 | 0x0080):  # any scale or 2x2 transform
                raise FontError(f"{self.name}: scaled composite glyphs are not supported")
            for contour in self.glyph(gid, depth + 1).contours:
                contours.append([(x + dx, y + dy, on) for x, y, on in contour])
            if not flags & 0x0020:  # MORE_COMPONENTS
                return contours

    def glyph_for_codepoint(self, codepoint: int) -> Glyph:
        if codepoint not in self.cmap:
            raise FontError(f"{self.name}: no glyph for U+{codepoint:04X}")
        return self.glyph(self.cmap[codepoint])


def contour_elements(points: list[tuple[int, int, bool]]) -> list[str]:
    """The path elements a TrueType contour draws, by kind: move, line, quad,
    close. Mirrors IconCatalog's decoder; the tests compare counts."""
    if not points:
        return []
    n = len(points)
    if points[0][2]:
        start = 0
    elif points[-1][2]:
        start = n - 1
    else:
        start = None  # starts at the implied midpoint of the last and first
    ordered = points[start:] + points[:start] if start is not None else points
    elements = ["move"]
    pending_control = False
    for x, y, on in (ordered[1:] if start is not None else ordered):
        if on:
            elements.append("quad" if pending_control else "line")
            pending_control = False
        else:
            if pending_control:
                elements.append("quad")  # to the implied on-curve midpoint
            pending_control = True
    if pending_control:
        elements.append("quad")  # back to the start
    elements.append("close")
    return elements


# --------------------------------------------------------------------------
# Glyph encoding
#
# One glyph is a byte string, base64 in the Swift file:
#   varint contourCount, varint pointCount per contour,
#   on-curve flags, one bit per point, least significant bit first,
#   then per point zigzag varints dx, dy from the previous point (the first
#   from 0,0), y pointing down from the ascender line.


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def zigzag(value: int) -> int:
    return (value << 1) if value >= 0 else ((-value << 1) - 1)


def encode_glyph(glyph: Glyph, ascender: int) -> bytes:
    out = bytearray(varint(len(glyph.contours)))
    for contour in glyph.contours:
        out += varint(len(contour))
    points = [p for contour in glyph.contours for p in contour]
    flag_bytes = bytearray((len(points) + 7) // 8)
    for i, (_, _, on) in enumerate(points):
        if on:
            flag_bytes[i // 8] |= 1 << (i % 8)
    out += flag_bytes
    px, py = 0, 0
    for x, y, _ in points:
        y = ascender - y
        out += varint(zigzag(x - px)) + varint(zigzag(y - py))
        px, py = x, y
    return bytes(out)


# --------------------------------------------------------------------------
# Scanning happy-app for the icons it names

STRING = r"""'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`"""
STRING_RE = re.compile(STRING)
IMPORT_RE = re.compile(r"import\s*\{([^}]*)\}\s*from\s*'@expo/vector-icons'")
# Keys and variables that hold an icon name: icon, iconName, statusIcon, ...
ICON_KEY = r"(?:[A-Za-z_$][\w$]*Icon(?:Name)?|icon(?:[A-Z][\w$]*)?)"
GLYPH_TYPE_RE = re.compile(
    r"keyof\s+typeof\s+(\w+)\.glyphMap|ComponentProps<\s*typeof\s+(\w+)\s*>\s*\[\s*'name'\s*\]"
)


@dataclass
class Site:
    path: str
    line: int
    family: str
    expression: str


def strip_comments(text: str) -> str:
    """Blanks out // and /* */ comments, keeping strings and line numbers."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c in "'\"`":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", text[i:j]))
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def balanced_end(text: str, start: int) -> int:
    """Index just past the bracket that closes the one at `start`."""
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack, i = [], start
    while i < len(text):
        c = text[i]
        if c in "'\"`":
            j = i + 1
            while j < len(text) and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif stack and c == stack[-1]:
            stack.pop()
            if not stack:
                return i + 1
        i += 1
    return len(text)


def split_top_level(expr: str, separators: list[str]) -> list[str]:
    parts, depth, i, last = [], 0, 0, 0
    while i < len(expr):
        c = expr[i]
        if c in "'\"`":
            j = i + 1
            while j < len(expr) and expr[j] != c:
                j += 2 if expr[j] == "\\" else 1
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0:
            for sep in separators:
                if expr.startswith(sep, i):
                    parts.append(expr[last:i])
                    i += len(sep)
                    last = i
                    break
            else:
                i += 1
            continue
        i += 1
    parts.append(expr[last:])
    return parts


def find_ternary(expr: str) -> tuple[int, int] | None:
    """The top-level `?` and its `:` in `a ? b : c`, if expr is a ternary."""
    depth, i, question, nested = 0, 0, -1, 0
    while i < len(expr):
        c = expr[i]
        if c in "'\"`":
            j = i + 1
            while j < len(expr) and expr[j] != c:
                j += 2 if expr[j] == "\\" else 1
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0 and c == "?" and expr[i + 1:i + 2] not in ("?", ".") and expr[i - 1:i] != "?":
            if question < 0:
                question = i
            else:
                nested += 1
        elif depth == 0 and c == ":" and question >= 0:
            if nested == 0:
                return question, i
            nested -= 1
        i += 1
    return None


def string_value(expr: str) -> str | None:
    m = STRING_RE.fullmatch(expr)
    if not m:
        return None
    return next(g for g in m.groups() if g is not None)


def results(expr: str) -> tuple[set[str], list[str]]:
    """The string literals an expression can evaluate to, and the parts of
    it that aren't literals."""
    expr = expr.strip()
    expr = re.sub(r"\s+as\s+(const|any|[\w.\[\]'<> ]+)\s*$", "", expr).strip()
    while expr.startswith("(") and balanced_end(expr, 0) == len(expr):
        expr = expr[1:-1].strip()
    ternary = find_ternary(expr)
    if ternary:
        q, c = ternary
        a, da = results(expr[q + 1:c])
        b, db = results(expr[c + 1:])
        return a | b, da + db
    parts = split_top_level(expr, ["||", "??"])
    if len(parts) > 1:
        names, dynamic = set(), []
        for part in parts:
            n, d = results(part)
            names |= n
            dynamic += d
        return names, dynamic
    parts = split_top_level(expr, ["&&"])
    if len(parts) > 1:
        return results(parts[-1])
    value = string_value(expr)
    if value is not None:
        return {value}, []
    return set(), [expr] if expr else []


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def statement_end(text: str, start: int) -> int:
    """Where an expression starting at `start` ends: the `,`, `;`, `}` or
    `)` that closes it, or a newline that doesn't continue it."""
    i = start
    while i < len(text):
        c = text[i]
        if c in "([{":
            i = balanced_end(text, i)
            continue
        if c in "'\"`":
            i = text.index(c, i + 1) + 1
            continue
        if c in ",;})]":
            return i
        if c == "\n":
            rest = text[i:].lstrip()
            if not rest.startswith(("?", ":", "||", "??", "&&")) and not text[start:i].rstrip().endswith(("?", ":", "||", "??", "&&", "=")):
                return i
        i += 1
    return i


def follow(part: str, text: str, depth: int = 0) -> set[str] | None:
    """What a non-literal part of a name expression evaluates to, read from
    the same file: a local constant, a helper's parameter, a helper's
    returns, an icon table, or `x.icon` fields. None if it can't be followed."""
    if depth > 4:
        return None
    part = re.sub(r"\s+as\s+.*$", "", part.strip()).strip()

    def resolve(expr: str) -> set[str] | None:
        names, dynamic = results(expr)
        for d in dynamic:
            more = follow(d, text, depth + 1)
            if more is None:
                return None
            names |= more
        return names

    def union(exprs: list[str]) -> set[str] | None:
        if not exprs:
            return None
        names: set[str] = set()
        for expr in exprs:
            more = resolve(expr)
            if more is None:
                return None
            names |= more
        return names

    # helper(args): the helper's returns.
    call = re.fullmatch(r"([A-Za-z_$][\w$]*)\((.*)\)", part, re.S)
    if call:
        fn = re.escape(call.group(1))
        exprs = []
        for m in re.finditer(rf"function\s+{fn}\s*\(|(?:const|let)\s+{fn}\s*=\s*(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>\s*", text):
            body_at = text.find("{", m.end()) if m.group(0).startswith("function") else m.end()
            if text[body_at] == "{":
                body = text[body_at:balanced_end(text, body_at)]
                exprs += [text_part for r in re.finditer(r"\breturn\s+", body)
                          for text_part in [body[r.end():statement_end(body, r.end())]]]
            else:
                exprs.append(text[body_at:statement_end(text, body_at)])
        return union(exprs)

    # table[key]: the table's values.
    index = re.fullmatch(r"([A-Za-z_$][\w$]*)\[.*\]", part, re.S)
    if index:
        m = re.search(rf"(?:const|let|var)\s+{re.escape(index.group(1))}\b[^=]*=\s*\{{", text)
        if not m:
            return None
        body = text[m.end() - 1:balanced_end(text, m.end() - 1)]
        return union([body[v.end():statement_end(body, v.end())] for v in re.finditer(r"[\w'\"]\s*:\s*", body)])

    # obj.icon, obj?.icon: every `icon:` field in the file.
    member = re.fullmatch(r".*[\w$)\]]\??\.([A-Za-z_$][\w$]*)", part, re.S)
    if member:
        prop = re.escape(member.group(1))
        exprs = [text[m.end():statement_end(text, m.end())]
                 for m in re.finditer(rf"(?<![\w$.]){prop}\s*:\s*(?=['\"`(\w])", text)]
        exprs = [e for e in exprs if not re.match(r"\s*(keyof|React\.|string\b|[A-Z]\w*<)", e)]
        return union(exprs)

    if not re.fullmatch(r"[A-Za-z_$][\w$]*", part):
        return None
    name = re.escape(part)
    # A helper's parameter: every call's argument in that position.
    exprs = []
    for m in re.finditer(r"(?:function\s+([\w$]+)\s*|(?:const|let)\s+([\w$]+)\s*=\s*)\(([^)]*)\)", text):
        params = [re.split(r"[:=?]", p)[0].strip() for p in m.group(3).split(",")]
        if part in params:
            fn = re.escape(m.group(1) or m.group(2))
            position = params.index(part)
            for c in re.finditer(rf"(?<![\w$.]){fn}\(", text):
                args = split_top_level(text[c.end():balanced_end(text, c.end() - 1) - 1], [","])
                if position < len(args) and args[position].strip():
                    exprs.append(args[position])
    if exprs:
        return union(exprs)
    # const x = …, and x = … as a statement. JSX attributes (name="x") have
    # no spaces around the `=`.
    for m in re.finditer(rf"(?:(?:const|let|var)\s+{name}\s*(?::[^=\n]*)?|(?m:^)[ \t]*{name}\s)=(?![=>])\s*", text):
        exprs.append(text[m.end():statement_end(text, m.end())])
    return union(exprs)


def scan_app(sources: Path, glyphmaps: dict[str, dict[str, int]]) -> tuple[dict[str, set[str]], list[Site]]:
    """Every icon name happy-app references, by family, and the JSX call
    sites whose name the scan could not reduce to literals."""
    found: dict[str, set[str]] = {f.component: set() for f in FAMILIES}
    unresolved: list[Site] = []
    files = sorted(
        p for p in sources.rglob("*")
        if p.suffix in (".ts", ".tsx")
        and "__testdata__" not in p.parts
        and not re.search(r"\.(test|spec)\.tsx?$", p.name)
    )
    for path in files:
        text = strip_comments(path.read_text(encoding="utf-8"))
        rel = str(path.relative_to(sources))
        imported = [
            name.strip().split(" as ")[-1].strip()
            for m in IMPORT_RE.finditer(text) for name in m.group(1).split(",")
        ]
        imported = [c for c in imported if c in FAMILY_BY_COMPONENT]

        def add(component: str, names: set[str]) -> set[str]:
            valid = {n for n in names if n in glyphmaps[component]}
            found[component] |= valid
            return valid

        # 1. JSX: <Ionicons name="…" />, name={cond ? 'a' : 'b'}, name={x}.
        for component in imported:
            for m in re.finditer(rf"<{component}\b", text):
                end = m.end()
                while end < len(text):
                    c = text[end]
                    if c == "{":
                        end = balanced_end(text, end)
                        continue
                    if c in "'\"":
                        end = text.index(c, end + 1) + 1
                        continue
                    if c == ">":
                        break
                    end += 1
                tag = text[m.end():end]
                attr = re.search(r"\bname\s*=\s*", tag)
                if not attr:
                    continue
                value_at = attr.end()
                if tag[value_at] == "{":
                    expression = tag[value_at + 1:balanced_end(tag, value_at) - 1]
                else:
                    expression = STRING_RE.match(tag, value_at).group(0)
                names, dynamic = results(expression)
                bad = {n for n in names if n not in glyphmaps[component]}
                if bad:
                    print(f"warning: {rel}:{line_of(text, m.start())}: {component} has no {sorted(bad)}",
                          file=sys.stderr)
                add(component, names)
                followed: set[str] = set()
                for part in dynamic:
                    more = follow(part, text)
                    if not more:
                        followed = set()
                        break
                    followed |= more
                if dynamic and followed:
                    add(component, followed)
                elif dynamic:
                    unresolved.append(Site(rel, line_of(text, m.start()), component, " ".join(expression.split())))

        # 2. Names held in icon-typed or icon-named places: `icon: 'add'`,
        # `const statusIcon = 'x'`, `iconByKey = { a: 'b' }`, and the
        # returns of functions typed `keyof typeof Ionicons.glyphMap`.
        def family_for(context: str) -> str | None:
            typed = GLYPH_TYPE_RE.search(context)
            if typed:
                return typed.group(1) or typed.group(2)
            if len(imported) == 1:
                return imported[0]
            return None

        def add_guessing(family: str | None, names: set[str]) -> None:
            if family:
                add(family, names)
                return
            # No import or several: the name belongs to the first family
            # (Ionicons before Octicons) that has it.
            for name in names:
                for f in FAMILIES:
                    if name in glyphmaps[f.component]:
                        found[f.component].add(name)
                        break

        for m in re.finditer(rf"(?<![\w$.])({ICON_KEY})\s*(?:\??:\s*(?=['\"`(])|=(?![=>])\s*)", text):
            start = m.end()
            # The value runs to the end of the property or statement.
            expr_end = start
            while expr_end < len(text) and text[expr_end] not in ",;}\n)":
                if text[expr_end] in "([{":
                    expr_end = balanced_end(text, expr_end)
                    continue
                if text[expr_end] in "'\"`":
                    expr_end = text.index(text[expr_end], expr_end + 1) + 1
                    continue
                expr_end += 1
            names, _ = results(text[start:expr_end])
            line_start = text.rfind("\n", 0, m.start()) + 1
            add_guessing(family_for(text[line_start:expr_end]), names)

        # Icon tables: const iconByKey = { processes: 'terminal-outline' }.
        for m in re.finditer(r"(?:const|let|var)\s+(\w*[Ii]con\w*)\s*(:[^=]*)?=\s*\{", text):
            body = text[m.end() - 1:balanced_end(text, m.end() - 1)]
            names = {string_value(v.group(1)) for v in re.finditer(rf":\s*({STRING})", body)}
            add_guessing(family_for(m.group(0)), {n for n in names if n})

        # Functions declared to return a glyph name: their returns.
        for m in GLYPH_TYPE_RE.finditer(text):
            family = m.group(1) or m.group(2)
            line_start = text.rfind("\n", 0, m.start()) + 1
            if family not in FAMILY_BY_COMPONENT or not re.search(r"\bfunction\b|\)\s*:\s*$", text[line_start:m.start()]):
                continue
            body_start = text.find("{", m.end())
            if body_start >= 0:
                body = text[body_start:balanced_end(text, body_start)]
                for r in re.finditer(r"\breturn\s+([^;\n]+)", body):
                    add(family, results(r.group(1))[0])

        # Union types of literals: icon: 'play-forward' | 'pause'.
        for m in re.finditer(rf"\b{ICON_KEY}\s*\??:\s*((?:{STRING})(?:\s*\|\s*(?:{STRING}))+)", text):
            names = {string_value(s.group(0)) for s in STRING_RE.finditer(m.group(1))}
            add_guessing(family_for(m.group(0)), {n for n in names if n})

    return found, unresolved


def read_extra(path: Path) -> tuple[dict[str, set[str]], set[tuple[str, str]]]:
    """icons-extra.txt: `<Family> <name>` adds a name the scan can't see;
    `reviewed <file> <expression>` marks a call site as read and covered,
    so the report stops listing it. `#` starts a comment."""
    extra: dict[str, set[str]] = {f.component: set() for f in FAMILIES}
    reviewed: set[tuple[str, str]] = set()
    if not path.exists():
        return extra, reviewed
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(None, 2)
        if parts[0] == "reviewed" and len(parts) == 3:
            reviewed.add((parts[1], " ".join(parts[2].split())))
        elif len(parts) == 2 and parts[0] in extra:
            extra[parts[0]].add(parts[1])
        else:
            raise SystemExit(f"{path}:{number}: expected '<Family> <name>' or 'reviewed <file> <expression>', got {line!r}")
    return extra, reviewed


# --------------------------------------------------------------------------
# Output


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


@dataclass
class FontTable:
    family: Family
    font: TrueTypeFont
    lines: list[str]  # "name advance base64"


def build(package: Path) -> tuple[str, str, list[Site], dict[str, int]]:
    vendor = package / "build" / "vendor" / "react-native-vector-icons"
    version = json.loads((package / "package.json").read_text())["version"]
    if version != LOCKED_VERSION:
        raise SystemExit(f"{package} is @expo/vector-icons {version}; happy-app locks {LOCKED_VERSION}")
    glyphmaps = {
        f.component: json.loads((vendor / "glyphmaps" / f.glyphmap).read_text()) for f in FAMILIES
    }
    found, unresolved = scan_app(APP_SOURCES, glyphmaps)
    extra, reviewed = read_extra(EXTRA_NAMES)
    for component, names in extra.items():
        missing = names - glyphmaps[component].keys()
        if missing:
            raise SystemExit(f"icons-extra.txt: {component} has no {sorted(missing)}")
        found[component] |= names

    tables: list[FontTable] = []
    counts: dict[str, int] = {}
    for family in FAMILIES:
        names = sorted(found[family.component])
        counts[family.component] = len(names)
        if not names:
            continue
        font = TrueTypeFont((vendor / "Fonts" / family.font).read_bytes(), family.font)
        lines = []
        for name in names:
            glyph = font.glyph_for_codepoint(glyphmaps[family.component][name])
            data = base64.b64encode(encode_glyph(glyph, font.ascender)).decode("ascii")
            lines.append(f"{name} {glyph.advance} {data}")
        tables.append(FontTable(family, font, lines))

    stale_reviews = reviewed - {(site.path, site.expression) for site in unresolved}
    for path, expression in sorted(stale_reviews):
        print(f"warning: icons-extra.txt reviews {path} {expression}, which is no longer a dynamic call site",
              file=sys.stderr)
    unresolved = [site for site in unresolved if (site.path, site.expression) not in reviewed]
    return swift_source(tables, version), licenses(tables, package, vendor), unresolved, counts


def swift_source(tables: list[FontTable], version: str) -> str:
    checksum = 0
    canonical = "".join(
        f"{t.family.component}\n{t.font.units_per_em} {t.font.ascender} {t.font.descender}\n" + "\n".join(t.lines) + "\n"
        for t in tables
    )
    checksum = fnv1a64(canonical.encode("utf-8"))
    out = [
        f"// Generated by scripts/generate-icons.py from @expo/vector-icons {version}. Do not edit.",
        "//",
        "// One table per font: its metrics in font units, then one line per glyph,",
        "// `name advance outline`. The outline is the glyph's TrueType contours,",
        "// packed and base64-encoded; `GlyphOutline` documents the format and",
        "// decodes it on first use. Kept as string literals so the file compiles",
        "// in no time, however many icons it holds.",
        "",
        f"let generatedIconsVersion = \"{version}\"",
        "",
        "/// FNV-1a 64 of the tables, as the generator wrote them. A hand edit, or",
        "/// a generator that stopped being deterministic, breaks the match.",
        f"let generatedIconsChecksum: UInt64 = 0x{checksum:016X}",
        "",
        "let generatedFonts: [GeneratedFont] = [",
    ]
    for t in tables:
        out += [
            "    GeneratedFont(",
            f"        family: .{t.family.case},",
            f"        unitsPerEm: {t.font.units_per_em},",
            f"        ascender: {t.font.ascender},",
            f"        descender: {t.font.descender},",
            '        glyphs: """',
            *[f"        {line}" for line in t.lines],
            '        """',
            "    ),",
        ]
    out.append("]")
    return "\n".join(out) + "\n"


def licenses(tables: list[FontTable], package: Path, vendor: Path) -> str:
    out = [
        "# Icon font licenses",
        "",
        "<!-- Generated by scripts/generate-icons.py. Do not edit. -->",
        "",
        "The outlines in `GeneratedIcons.swift` are generated from the icon fonts that",
        "`@expo/vector-icons` bundles from react-native-vector-icons. No font file",
        "ships with the app; the glyph outlines do, so each font's notice is kept",
        "here, with the strings the font itself carries.",
        "",
        "## Fonts",
        "",
    ]
    licenses_used = set()
    for t in tables:
        out += [f"### {t.family.component} (`{t.family.font}`, {len(t.lines)} icon{'' if len(t.lines) == 1 else 's'})", "", "```", t.family.notice, "```", ""]
        if "MIT" in t.family.notice:
            licenses_used.add("MIT")
        if "Apache" in t.family.notice:
            licenses_used.add("Apache")
        names = t.font.names
        for name_id, label in [(0, "Copyright"), (1, "Family"), (5, "Version"), (13, "License"), (14, "License URL")]:
            if names.get(name_id):
                value = " ".join(names[name_id].split())
                out.append(f"- Font {label.lower()}: {value}")
        out.append("")
    if "MIT" in licenses_used:
        out += ["## MIT License", "", "```", MIT_TEXT, "```", ""]
    if "Apache" in licenses_used:
        out += ["## Apache License, Version 2.0", "", "```", APACHE_TEXT, "```", ""]
    out += [
        "## @expo/vector-icons",
        "",
        "```",
        (package / "LICENSE").read_text().strip(),
        "```",
        "",
        "## react-native-vector-icons",
        "",
        "```",
        (vendor / "LICENSE").read_text().strip(),
        "```",
        "",
    ]
    return "\n".join(out)


def default_package() -> Path:
    return REPO_ROOT / "node_modules" / "@expo" / "vector-icons"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("package", nargs="?", type=Path, default=None,
                        help="path to @expo/vector-icons (default: the repo's node_modules)")
    parser.add_argument("--check", action="store_true",
                        help="regenerate in memory; fail if not deterministic or the files are stale")
    args = parser.parse_args()
    package = args.package or default_package()
    if not (package / "package.json").exists():
        raise SystemExit(f"no @expo/vector-icons at {package}; pass its path")

    swift, license_text, unresolved, counts = build(package)
    print("icons: " + ", ".join(f"{k} {v}" for k, v in counts.items() if v))
    if unresolved:
        print(f"\n{len(unresolved)} call sites name an icon the scan can't follow. Check that what they")
        print("produce is covered (by the scan elsewhere in the file, or scripts/icons-extra.txt):")
        for site in unresolved:
            print(f"  {site.path}:{site.line}  <{site.family} name={{{site.expression}}}>")

    if args.check:
        again, again_licenses, _, _ = build(package)
        if (again, again_licenses) != (swift, license_text):
            raise SystemExit("not deterministic: two runs produced different output")
        stale = [p for p, text in [(OUTPUT_SWIFT, swift), (OUTPUT_LICENSES, license_text)]
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            raise SystemExit("stale, rerun scripts/generate-icons.py: " + ", ".join(str(p) for p in stale))
        print("\nup to date, and two runs match")
        return

    OUTPUT_SWIFT.write_text(swift, encoding="utf-8")
    OUTPUT_LICENSES.write_text(license_text, encoding="utf-8")
    print(f"\nwrote {OUTPUT_SWIFT.relative_to(REPO_ROOT)} ({len(swift.encode())} bytes)")
    print(f"wrote {OUTPUT_LICENSES.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
