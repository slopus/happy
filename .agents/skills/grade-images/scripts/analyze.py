# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import argparse
import json
from pathlib import Path

from grade_core import analyze_array, load_image, sha256_file


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure photos without modifying them.")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    results = []
    for path in args.inputs:
        rgb, alpha, metadata = load_image(path)
        results.append(
            {
                "path": str(path.resolve()),
                "sha256": sha256_file(path),
                "width": int(rgb.shape[1]),
                "height": int(rgb.shape[0]),
                "has_alpha": alpha is not None,
                "source_mode": metadata["source_mode"],
                "has_icc_profile": metadata["source_icc_present"],
                "has_exif": metadata["exif"] is not None,
                "working_profile": metadata["working_profile"],
                "color_management": metadata["color_management"],
                "warnings": metadata["warnings"],
                "measurements": analyze_array(rgb),
            }
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"schema_version": "1.0", "images": results}, indent=2), encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
