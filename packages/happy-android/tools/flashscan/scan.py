#!/usr/bin/env python3
"""Scans a screen recording for bright frames: a dark app that flashes light.

  scan.py recording.mp4 [--frames DIR] [--threshold 0.25] [--json]

Per frame it measures the share of pixels brighter than luma 180 (of 255). A
dark screen is mostly well under 0.1 (white text, a few light pictures); a
light window, sheet or page is most of the frame. It prints the brightest
frames with their times, and writes each frame over the threshold as a PNG
into DIR when given. The exit status is 1 when any frame is over it.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

W, H = 108, 240  # scaled down: a flash is most of the screen, not a detail


def frames(path):
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "json", path]))
    times = [float(f.get("pts_time", 0)) for f in probe["frames"]]
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", path, "-fps_mode", "passthrough", "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
    data = np.frombuffer(raw, np.uint8).reshape(-1, H, W)
    return times[: len(data)], data


def main():
    p = argparse.ArgumentParser()
    p.add_argument("recording")
    p.add_argument("--frames")
    p.add_argument("--threshold", type=float, default=0.25)
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    times, data = frames(a.recording)
    bright = (data > 180).mean(axis=(1, 2))
    mean = data.mean(axis=(1, 2)) / 255
    over = [i for i, b in enumerate(bright) if b > a.threshold]
    if a.frames and over:
        os.makedirs(a.frames, exist_ok=True)
        for i in over[:40]:
            out = os.path.join(a.frames, f"{os.path.splitext(os.path.basename(a.recording))[0]}-{times[i]:07.3f}.png")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{times[i]}", "-i", a.recording, "-frames:v", "1", "-vf", "scale=540:-1", out], check=False)
    top = sorted(range(len(bright)), key=lambda i: -bright[i])[:5]
    result = {
        "recording": os.path.basename(a.recording),
        "frames": len(data),
        "maxBright": round(float(bright.max()), 3) if len(data) else 0,
        "maxMeanLuma": round(float(mean.max()), 3) if len(data) else 0,
        "overThreshold": len(over),
        "brightest": [{"t": round(times[i], 3), "bright": round(float(bright[i]), 3), "meanLuma": round(float(mean[i]), 3)} for i in top],
    }
    print(json.dumps(result) if a.json else json.dumps(result, indent=1))
    sys.exit(1 if over else 0)


if __name__ == "__main__":
    main()
