"""Join Settings tap → first changed NavMotion offset → display presentation.

Requires Perfetto trace_processor and NavigationBenchmark traces from a bench
APK with Happy:navFirstMove markers. See research/nothing-phone-perf.md.
"""

import argparse
from collections import Counter
import csv
import io
import json
import math
from pathlib import Path
import statistics
import subprocess

# Input eventTimeNano is MONOTONIC, not the trace clock (usually BOOTTIME).
# App FrameTimeline ends at buffer readiness. SurfaceFlinger ends at display
# presentation. A skipped/dropped first moved frame requires the next buffer.
QUERY = """
WITH inputs AS (
  SELECT i.id, i.ts AS dispatch_ts, i.track_id, p.upid,
    CASE WHEN i.name LIKE 'dispatchInputEvent MotionEvent%' THEN 'push' ELSE 'back' END AS direction,
    CAST(SUBSTR(e.name, INSTR(e.name, 'eventTimeNano=') + 14) AS INT)
      + i.ts - to_monotonic(i.ts) AS event_ts
  FROM slice i
  JOIN thread_track tt ON tt.id = i.track_id
  JOIN thread t USING (utid)
  JOIN process p USING (upid)
  JOIN slice e ON e.track_id = i.track_id AND e.ts >= i.ts
    AND e.ts + e.dur <= i.ts + i.dur
    AND e.name GLOB 'deliverInputEvent src=0x* eventTimeNano=*'
  WHERE p.name = 'com.slopus.happy.bench' AND t.tid = p.pid
    AND (i.name LIKE 'dispatchInputEvent MotionEvent ACTION_UP%'
      OR i.name LIKE 'dispatchInputEvent MotionEvent UP %' /* back-input */)
), markers AS (
  SELECT i.*, m.ts AS marker_ts,
    ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY m.ts, m.id) AS rank
  FROM inputs i JOIN slice m ON m.track_id = i.track_id
    AND m.ts >= i.dispatch_ts AND m.ts < i.dispatch_ts + 1000000000
    AND m.name LIKE 'Happy:navFirstMove:%'
), first_frames AS (
  SELECT m.*, f.ts AS frame_ts, f.dur AS frame_dur,
    CAST(SUBSTR(f.name, INSTR(f.name, ' ') + 1) AS INT) AS initial_frame_token,
    (SELECT app.layer_name FROM actual_frame_timeline_slice app
      WHERE app.upid = m.upid AND app.layer_name LIKE '%MainActivity%'
        AND app.ts <= m.marker_ts AND app.surface_frame_token IS NOT NULL
      ORDER BY app.ts DESC LIMIT 1) AS layer_name
  FROM markers m
  JOIN slice f ON f.track_id = m.track_id
    AND m.marker_ts >= f.ts AND m.marker_ts < f.ts + f.dur
    AND f.name GLOB 'Choreographer#doFrame [0-9]*'
  WHERE m.rank = 1
), presented AS (
  SELECT f.*, app.surface_frame_token,
    app.ts + app.dur AS buffer_ready_ts,
    display.display_frame_token, display.ts + display.dur AS present_ts,
    ROW_NUMBER() OVER (PARTITION BY f.id ORDER BY display.ts + display.dur, app.ts) AS present_rank
  FROM first_frames f
  JOIN actual_frame_timeline_slice app ON app.upid = f.upid
    AND app.layer_name = f.layer_name AND app.surface_frame_token >= f.initial_frame_token
    AND app.ts >= f.frame_ts - 1000000
    AND app.ts < f.frame_ts + 1000000000
    AND app.present_type != 'Dropped Frame'
  JOIN actual_frame_timeline_slice display
    ON display.display_frame_token = app.display_frame_token
    AND display.surface_frame_token IS NULL
    AND display.present_type != 'Dropped Frame' AND display.dur > 0
)
SELECT direction, event_ts, dispatch_ts, marker_ts, frame_ts, frame_dur, buffer_ready_ts,
  present_ts, initial_frame_token, surface_frame_token, display_frame_token,
  COALESCE((SELECT app.present_type FROM actual_frame_timeline_slice app
    WHERE app.upid = presented.upid AND app.surface_frame_token = initial_frame_token
      AND app.layer_name = presented.layer_name LIMIT 1), 'No submitted buffer') AS first_frame_status,
  surface_frame_token != initial_frame_token AS first_frame_skipped_or_dropped,
  ROUND((dispatch_ts-event_ts)/1e6, 3) AS input_queue_ms,
  ROUND((marker_ts-event_ts)/1e6, 3) AS first_movement_sample_ms,
  ROUND((frame_ts-event_ts)/1e6, 3) AS moving_frame_start_ms,
  ROUND(frame_dur/1e6, 3) AS moving_frame_main_ms,
  ROUND((buffer_ready_ts-event_ts)/1e6, 3) AS buffer_ready_ms,
  ROUND((present_ts-event_ts)/1e6, 3) AS tap_to_presented_movement_ms
FROM presented WHERE present_rank = 1
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("traces", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--trace-processor", default="trace_processor")
    parser.add_argument("--include-back", action="store_true", help="Also join the macrobenchmark's system Back key-up")
    args = parser.parse_args()
    back = "OR i.name LIKE 'dispatchInputEvent KeyEvent ACTION_UP%' OR i.name LIKE 'dispatchInputEvent KeyEvent UP %'"
    query = QUERY.replace("/* back-input */", back if args.include_back else "")
    rows = []
    for trace in sorted(args.traces.glob("NavigationBenchmark_settings*_iter*.perfetto-trace")):
        result = subprocess.run(
            [args.trace_processor, str(trace), "-Q", query],
            text=True, capture_output=True, check=True,
        )
        found = list(csv.DictReader(io.StringIO(result.stdout)))
        expected = ["back", "push"] if args.include_back else ["push"]
        if sorted(row["direction"] for row in found) != expected:
            raise RuntimeError(f"{trace.name}: expected {expected} input/moved/presented frames, got {found}; inspect trace")
        for sample in found:
            row = {"trace": trace.name, "journey": "cold" if "settingsCold" in trace.name else "warm", **sample}
            if not 0 <= float(row["input_queue_ms"]) < 1000:
                raise RuntimeError(f"Invalid input clock mapping: {row}")
            if float(row["tap_to_presented_movement_ms"]) < float(row["first_movement_sample_ms"]):
                raise RuntimeError(f"Presentation predates movement: {row}")
            rows.append(row)
    if not rows:
        raise RuntimeError("No Settings traces found")

    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / "samples.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    summary = {}
    groups = {(row["journey"], row["direction"]) for row in rows}
    for journey, direction in sorted(groups):
        selected = [row for row in rows if row["journey"] == journey and row["direction"] == direction]
        values = sorted(float(row["tap_to_presented_movement_ms"]) for row in selected)
        summary[f"{journey}_{direction}" if args.include_back else journey] = {
            "n": len(values),
            "median_ms": round(statistics.median(values), 3),
            "p90_ms": values[math.ceil(len(values) * .9) - 1],
            "first_frame_status": dict(Counter(row["first_frame_status"] for row in selected)),
            "first_moved_frame_skipped_or_dropped": sum(int(row["first_frame_skipped_or_dropped"]) for row in selected),
        }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()