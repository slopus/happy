-- Recurring main-thread work, 50–450 ms after the measured push/first Back.
-- Run with trace_processor_shell <trace> -q retention-frame-work.sql.
-- These nested slices overlap: do not add their durations together.
WITH inputs AS (
  SELECT s.ts, p.upid,
    CASE WHEN s.name LIKE '%MotionEvent%' THEN 'push' ELSE 'back' END AS direction
  FROM slice s JOIN thread_track tt ON tt.id = s.track_id
    JOIN thread t USING (utid) JOIN process p USING (upid)
  WHERE p.name = 'com.slopus.happy.bench' AND t.tid = p.pid
    AND (s.name LIKE 'dispatchInputEvent MotionEvent ACTION_UP%'
      OR s.name LIKE 'dispatchInputEvent MotionEvent UP %'
      OR s.name LIKE 'dispatchInputEvent KeyEvent ACTION_UP%'
      OR s.name LIKE 'dispatchInputEvent KeyEvent UP %')
), chosen AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY direction ORDER BY ts) AS n FROM inputs
)
SELECT i.direction, s.name, COUNT(*) AS samples,
  ROUND(AVG(s.dur) / 1e6, 3) AS mean_ms,
  ROUND(SUM(s.dur) / 1e6, 3) AS total_ms
FROM chosen i
JOIN thread t ON t.upid = i.upid AND t.tid = (SELECT pid FROM process WHERE upid = i.upid)
JOIN thread_track tt USING (utid)
JOIN slice s ON s.track_id = tt.id
  AND s.ts >= i.ts + 50000000 AND s.ts < i.ts + 450000000 AND s.dur > 0
WHERE i.n = 1 AND s.name IN (
  'Recomposer:recompose', 'Compose:recompose', 'Recomposer:animation',
  'AndroidOwner:measureAndLayout', 'AndroidOwner:draw',
  'Compose:onPositionedCallbacks', 'Record View#draw()', 'postAndWait',
  'ContentCapture:changeChecker', 'getAllUncoveredSemanticsNodesToIntObjectMap'
)
GROUP BY i.direction, s.name
ORDER BY i.direction, s.name;