import { getHeapStatistics } from "node:v8";
import { getLogger } from "./logger.js";

const STALL_CHECK_MS = 1_000;
const STALL_REPORT_MS = 5_000;

/**
 * A blocked event loop fires every pending checkout and transaction timeout at once when it
 * resumes. Heap figures tell garbage collection near the heap limit apart from synchronous work.
 */
export function watchEventLoopStalls(
  message: `${string}.event_loop_stalled`,
  now: () => number = Date.now,
): () => void {
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const stallMs = at - last - STALL_CHECK_MS;
    last = at;
    if (stallMs < STALL_REPORT_MS) return;
    const heap = getHeapStatistics();
    const memory = process.memoryUsage();
    getLogger().warn(message, {
      "event_loop.stall_ms": stallMs,
      "memory.heap_used_bytes": heap.used_heap_size,
      "memory.heap_limit_bytes": heap.heap_size_limit,
      "memory.external_bytes": memory.external,
      "memory.rss_bytes": memory.rss,
    });
  }, STALL_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
