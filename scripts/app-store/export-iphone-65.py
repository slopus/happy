"""Export the selected iPhone compositions for App Store Connect's 6.5-inch slot.

Requires Pillow: python3 -m pip install Pillow
"""

import argparse
from pathlib import Path

from PIL import Image, ImageCms, ImageOps


ROOT = Path(__file__).resolve().parents[2]
FILES = (
    "01-models.png",
    "02-sessions.png",
    "03-desktop.png",
    "04-multiplayer.png",
    "05-source.png",
)
SOURCE_SIZE = (1320, 2868)
TARGET_SIZE = (1284, 2778)
BACKGROUND = (245, 240, 231)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=ROOT / "marketing/app-store/en-US/iphone"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "marketing/app-store/en-US/iphone-6.5-inch-1284x2778",
    )
    args = parser.parse_args()
    images = []
    for name in FILES:
        with Image.open(args.source / name) as image:
            if (
                image.format != "PNG"
                or image.size != SOURCE_SIZE
                or image.mode != "RGB"
                or "transparency" in image.info
            ):
                raise ValueError(f"{name}: expected opaque RGB PNG at {SOURCE_SIZE}")
            image.load()
            images.append(image.copy())

    # A fresh directory keeps the upload selection to exactly the five final PNGs.
    args.out.mkdir(parents=True, exist_ok=False)
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    for name, image in zip(FILES, images):
        # Fit the entire approved composition without cropping or stretching.
        fitted = ImageOps.contain(image, TARGET_SIZE, Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", TARGET_SIZE, BACKGROUND)
        offset = tuple((target - actual) // 2 for target, actual in zip(TARGET_SIZE, fitted.size))
        canvas.paste(fitted, offset)
        path = args.out / name
        canvas.save(path, format="PNG", icc_profile=srgb)
        with Image.open(path) as exported:
            exported.load()
            assert exported.format == "PNG" and exported.size == TARGET_SIZE
            assert exported.mode == "RGB" and "transparency" not in exported.info
            assert exported.info["icc_profile"] == srgb
        print(f"{name}: 1284 × 2778, opaque RGB PNG, sRGB")
    print(f"Ready for the 6.5-inch upload slot: {args.out.resolve()}")


if __name__ == "__main__":
    main()