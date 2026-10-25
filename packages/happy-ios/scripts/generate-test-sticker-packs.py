#!/usr/bin/env python3
"""Tiny sticker packs for the Stories end-to-end tests, drawn here.

The daemon ships no packs, and real packs are someone's art: never test
with them. This writes packs in the daemon's folder format (happy-agent
`API.md` "Stickers": one folder per pack with `pack.json` and its files,
each named and checked by its SHA-256):

    generate-test-sticker-packs.py <agent home>/stickers

- `happy-test-shapes` — six still `webp` shapes, kind `stickers`;
- `happy-test-glyphs` — four still `webp` glyphs, kind `emoji`;
- `happy-test-motion` — one animated `tgs` sticker, a Lottie made here:
  a pink rounded square that turns and breathes, a white dot to see it turn.

Needs Pillow with WebP.
"""

import gzip
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


def spin_lottie() -> dict:
    """Two seconds at 30 fps, looping: one turn, shrinking to 70% and back."""
    ease = {"i": {"x": [0.5], "y": [1]}, "o": {"x": [0.5], "y": [0]}}
    ease3 = {"i": {"x": [0.5] * 3, "y": [1] * 3}, "o": {"x": [0.5] * 3, "y": [0] * 3}}
    still = lambda value: {"a": 0, "k": value}
    transform = {"ty": "tr", "p": still([0, 0]), "a": still([0, 0]), "s": still([100, 100]), "r": still(0), "o": still(100)}
    return {
        "v": "5.7.4", "fr": 30, "ip": 0, "op": 60, "w": 512, "h": 512, "nm": "spin", "ddd": 0, "assets": [],
        "layers": [{
            "ddd": 0, "ind": 1, "ty": 4, "nm": "spin", "sr": 1, "ao": 0, "ip": 0, "op": 60, "st": 0, "bm": 0,
            "ks": {
                "o": still(100),
                "r": {"a": 1, "k": [{"t": 0, "s": [0], **ease}, {"t": 60, "s": [360]}]},
                "p": still([256, 256, 0]),
                "a": still([0, 0, 0]),
                "s": {"a": 1, "k": [{"t": 0, "s": [100, 100, 100], **ease3}, {"t": 30, "s": [70, 70, 100], **ease3}, {"t": 60, "s": [100, 100, 100]}]},
            },
            "shapes": [
                {"ty": "gr", "nm": "dot", "it": [
                    {"ty": "el", "nm": "e", "d": 1, "s": still([70, 70]), "p": still([0, -90])},
                    {"ty": "fl", "nm": "f", "c": still([1, 1, 1, 1]), "o": still(100), "r": 1},
                    transform,
                ]},
                {"ty": "gr", "nm": "square", "it": [
                    {"ty": "rc", "nm": "r", "d": 1, "s": still([300, 300]), "p": still([0, 0]), "r": still(80)},
                    {"ty": "fl", "nm": "f", "c": still([1, 0.216, 0.373, 1]), "o": still(100), "r": 1},
                    transform,
                ]},
            ],
        }],
    }


def write_lottie_pack(root: Path, pack_id: str, title: str) -> None:
    folder = root / pack_id
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.iterdir():
        old.unlink()
    # gzip with no name and no time, so the file and its digest never change.
    data = gzip.compress(json.dumps(spin_lottie(), separators=(",", ":")).encode(), mtime=0)
    digest = hashlib.sha256(data).hexdigest()
    (folder / f"{digest}.tgs").write_bytes(data)
    sticker = {"id": "spin", "file": f"{digest}.tgs", "emoji": ["🌀"], "format": "tgs",
               "width": 512, "height": 512, "size": len(data), "sha256": digest}
    manifest = {"id": pack_id, "title": title, "kind": "stickers", "thumbnail": "spin", "stickers": [sticker]}
    (folder / "pack.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    write_pack(root, "happy-test-shapes", "Test Shapes", "stickers", SHAPES, 256)
    write_pack(root, "happy-test-glyphs", "Test Glyphs", "emoji", GLYPHS, 100)
    write_lottie_pack(root, "happy-test-motion", "Test Motion")
    print(f"wrote 3 packs to {root}")


if __name__ == "__main__":
    main()
