"""Frame tails for the measured push and first Back in NavigationBenchmark.

Uses the first 650 ms after each input, including destination creation and the
450 ms transition. The optional second Back (return to home) is not included.
These are frame durations, not tap-to-first-pixel latency. Pass directories
containing the four chat/agentPage/settingsPage/artifacts trace sets.
"""

import argparse
import csv
import io
import json
from pathlib import Path
import statistics
import subprocess

QUERY = """
WITH inputs AS (
  SELECT s.ts, p.upid,
    CASE WHEN s.name LIKE '%MotionEvent%' THEN 'push' ELSE 'back' END AS direction
  FROM slice s JOIN thread_track tt ON tt.id=s.track_id
    JOIN thread t USING(utid) JOIN process p USING(upid)
  WHERE p.name='com.slopus.happy.bench' AND t.tid=p.pid
    AND (s.name LIKE 'dispatchInputEvent MotionEvent ACTION_UP%'
      OR s.name LIKE 'dispatchInputEvent MotionEvent UP %'
      OR s.name LIKE 'dispatchInputEvent KeyEvent ACTION_UP%'
      OR s.name LIKE 'dispatchInputEvent KeyEvent UP %')
), chosen AS (
  SELECT *, ROW_NUMBER() OVER(PARTITION BY direction ORDER BY ts) AS n FROM inputs
)
SELECT i.direction, f.ts, f.dur/1e6 AS main_ms, a.dur/1e6 AS frame_ms, a.jank_type
FROM chosen i
JOIN thread t ON t.upid=i.upid AND t.tid=(SELECT pid FROM process WHERE upid=i.upid)
JOIN thread_track tt USING(utid)
JOIN slice f ON f.track_id=tt.id AND f.name GLOB 'Choreographer#doFrame [0-9]*'
  AND f.ts>=i.ts AND f.ts<i.ts+650000000 AND f.dur>0
JOIN actual_frame_timeline_slice a ON a.upid=i.upid
  AND a.surface_frame_token=CAST(SUBSTR(f.name, INSTR(f.name,' ')+1) AS INT)
  AND a.layer_name LIKE '%MainActivity%' AND a.dur>0
WHERE i.n=1
"""


def percentile(values, share):
    values = sorted(values)
    index = (len(values) - 1) * share
    low = int(index)
    high = min(low + 1, len(values) - 1)
    return round(values[low] + (values[high] - values[low]) * (index - low), 3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("traces", type=Path, nargs="+")
    parser.add_argument("--trace-processor", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--journeys", nargs="+", default=["chat", "agentPage", "settingsPage", "artifacts"])
    args = parser.parse_args()
    rows = []
    for directory in args.traces:
        for trace in sorted(directory.glob("NavigationBenchmark_*_iter*.perfetto-trace")):
            journey = trace.name.split("_iter")[0].removeprefix("NavigationBenchmark_")
            if journey not in args.journeys:
                continue
            result = subprocess.run([args.trace_processor, str(trace), "-Q", QUERY], capture_output=True, text=True, check=True)
            found = list(csv.DictReader(io.StringIO(result.stdout)))
            if {row["direction"] for row in found} != {"push", "back"}:
                raise RuntimeError(f"Missing push/Back frame windows: {trace}")
            rows.extend({"trace": trace.name, "journey": journey, **row} for row in found)
    if not rows:
        raise RuntimeError("No matching traces")
    summary = {}
    for journey, direction in sorted({(row["journey"], row["direction"]) for row in rows}):
        group = [row for row in rows if (row["journey"], row["direction"]) == (journey, direction)]
        summary[f"{journey}_{direction}"] = {
            "iterations": len({row["trace"] for row in group}),
            "frames": len(group),
            **{f"{metric}_{stat}": (round(statistics.median(values), 3) if stat == "median" else percentile(values, .99))
               for metric in ("main_ms", "frame_ms")
               for values in [[float(row[metric]) for row in group]]
               for stat in ("median", "p99")},
            "janky_frames": sum(row["jank_type"] != "None" for row in group),
        }
    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / "frames.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()