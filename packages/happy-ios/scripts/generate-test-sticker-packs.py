#!/usr/bin/env python3
"""Tiny sticker packs for the Stories end-to-end tests, drawn here.

The daemon ships no packs, and real packs are someone's art: never test
with them. This writes packs in the daemon's folder format (happy-agent
`API.md` "Stickers": one folder per pack with `pack.json` and its files,
each named and checked by its SHA-256):

    generate-test-sticker-packs.py <agent home>/stickers

- `happy-test-shapes` — six still `webp` shapes, kind `stickers`;
- `happy-test-glyphs` — four still `webp` glyphs, kind `emoji`.

Needs Pillow with WebP.
"""

import hashlib
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SHAPES = [
    ("circle", "🔵", (10, 132, 255), "circle"),
    ("square", "🟥", (255, 69, 58), "square"),
    ("star", "⭐", (255, 214, 10), "star"),
    ("heart", "❤️", (255, 55, 95), "heart"),
    ("drop", "💧", (100, 210, 255), "circle"),
    ("leaf", "🍀", (48, 209, 88), "square"),
]

GLYPHS = [
    ("plus", "➕", (255, 159, 10), "square"),
    ("ring", "⭕", (191, 90, 242), "circle"),
    ("spark", "✨", (255, 214, 10), "star"),
    ("love", "💖", (255, 55, 95), "heart"),
]


def draw(shape: str, color: tuple, size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)
    m = size * 0.1
    box = (m, m, size - m, size - m)
    fill = color + (255,)
    outline = (255, 255, 255, 255)
    width = max(2, size // 32)
    if shape == "circle":
        pen.ellipse(box, fill=fill, outline=outline, width=width)
    elif shape == "square":
        pen.rounded_rectangle(box, radius=size * 0.16, fill=fill, outline=outline, width=width)
    elif shape == "star":
        c = size / 2
        points = []
        for i in range(10):
            r = (size / 2 - m) if i % 2 == 0 else size * 0.18
            a = i * math.pi / 5 - math.pi / 2
            points.append((c + r * math.cos(a), c + r * math.sin(a)))
        pen.polygon(points, fill=fill, outline=outline)
    elif shape == "heart":
        r = size * 0.22
        pen.ellipse((size * 0.12, size * 0.18, size * 0.12 + 2 * r, size * 0.18 + 2 * r), fill=fill)
        pen.ellipse((size * 0.88 - 2 * r, size * 0.18, size * 0.88, size * 0.18 + 2 * r), fill=fill)
        pen.polygon([(size * 0.13, size * 0.45), (size * 0.87, size * 0.45), (size * 0.5, size * 0.88)], fill=fill)
    return image


def write_pack(root: Path, pack_id: str, title: str, kind: str, items: list, size: int) -> None:
    folder = root / pack_id
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.iterdir():
        old.unlink()
    stickers = []
    for sticker_id, emoji, color, shape in items:
        path = folder / "tmp.webp"
        draw(shape, color, size).save(path, "WEBP", lossless=True)
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        path.rename(folder / f"{digest}.webp")
        stickers.append({
            "id": sticker_id, "file": f"{digest}.webp", "emoji": [emoji], "format": "webp",
            "width": size, "height": size, "size": len(data), "sha256": digest,
        })
    manifest = {"id": pack_id, "title": title, "kind": kind, "thumbnail": items[0][0], "stickers": stickers}
    (folder / "pack.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    write_pack(root, "happy-test-shapes", "Test Shapes", "stickers", SHAPES, 256)
    write_pack(root, "happy-test-glyphs", "Test Glyphs", "emoji", GLYPHS, 100)
    print(f"wrote 2 packs to {root}")


if __name__ == "__main__":
    main()
