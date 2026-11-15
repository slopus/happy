import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import type { BackgroundJobExecution } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";

function admissionMemory(activeRuns: number) {
  // One incoming run needs room for an attachment and its decoding/copying.
  // Resident allocations are already reflected in available physical memory.
  const reserve = ATTACHMENT_MAX_BYTES * 4;
  const available = process.availableMemory() + reclaimableFileCache();
  const heap = getHeapStatistics();
  // V8 may hit its own heap ceiling while physical RAM remains available.
  // External buffers are already reflected in physical memory, not heap usage.
  const heapAvailable = heap.heap_size_limit - heap.used_heap_size;
  const physicalPressure = available <= reserve;
  const heapPressure = heapAvailable <= reserve;
  return {
    reason: heapPressure
      ? physicalPressure
        ? "heap_and_physical"
        : "heap"
      : physicalPressure
        ? "physical"
        : undefined,
    fields: {
      "worker.active_runs": activeRuns,
      "memory.available_bytes": available,
      "memory.reserve_bytes": reserve,
      "memory.heap_available_bytes": heapAvailable,
      "memory.heap_used_bytes": heap.used_heap_size,
      "memory.heap_limit_bytes": heap.heap_size_limit,
    },
  };
}

/**
 * In a memory-limited container, available memory is the limit minus usage, and usage includes
 * the page cache left by file reads and writes. The kernel drops its inactive part under
 * pressure, so counting it as used stalls runs while the worker has room. Only cgroup v2 is read.
 */
function reclaimableFileCache(): number {
  if (!process.constrainedMemory()) return 0;
  try {
    const group = /^0::(\/.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
    if (!group) return 0;
    const stat = readFileSync(`/sys/fs/cgroup${group === "/" ? "" : group}/memory.stat`, "utf8");
    return Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** Tracks agent lifetimes separately from short wakeup deliveries. */
export class RunExecutionHost {
  private stopping = false;
  private pressure: { since: number; reason: string } | undefined;
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly capacityWaiters = new Set<() => void>();

  get activeCount(): number {
    return this.activeRuns.size;
  }

  start(): void {
    this.stopping = false;
    this.pressure = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pressure = undefined;
    for (const notify of this.capacityWaiters) notify();
    await Promise.allSettled(this.activeRuns);
  }

  /** Returns false before invoking the callback when nonwaiting admission has no capacity. */
  async execute(
    execute: (execution: BackgroundJobExecution) => Promise<void>,
    options: { waitForCapacity?: boolean } = {},
  ): Promise<boolean> {
    // A waiting network request consumes no dispatch capacity. Admit independent
    // runs while the process has memory headroom, rather than limiting their count.
    // Under real pressure, wait for a resident run to finish before loading more
    // histories. With no resident runs, allow work to resume instead of deadlocking
    // behind memory that has not been reclaimed yet.
    while (this.activeRuns.size > 0) {
      if (this.stopping) throw new Error("Worker is stopping");
      const memory = admissionMemory(this.activeRuns.size);
      if (!memory.reason) break;
      if (!this.pressure) {
        this.pressure = { since: Date.now(), reason: memory.reason };
        getLogger().info("run.admission_wait", {
          "admission.reason": this.pressure.reason,
          ...memory.fields,
        });
      }
      if (options.waitForCapacity === false) return false;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.capacityWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 1_000);
        timer.unref?.();
        this.capacityWaiters.add(finish);
      });
    }
    if (this.stopping) throw new Error("Worker is stopping");
    if (this.pressure) {
      getLogger().info("run.admission_resumed", {
        "admission.reason": this.pressure.reason,
        "run.admission_wait_ms": Math.max(0, Date.now() - this.pressure.since),
        ...admissionMemory(this.activeRuns.size).fields,
      });
      this.pressure = undefined;
    }
    let onRunStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      onRunStarted = resolve;
    });
    const executing = execute({ onRunStarted });
    const finish = () => {
      this.activeRuns.delete(tracked);
      for (const notify of this.capacityWaiters) notify();
    };
    // runCorrelatedJob reports failures in their original context. Observe the
    // rejection after handoff without reporting it again. Before handoff, the
    // original rejecting promise below still reaches Graphile's retry handling.
    const tracked = executing.then(finish, finish);
    this.activeRuns.add(tracked);
    await Promise.race([started, executing]);
    return true;
  }
}
