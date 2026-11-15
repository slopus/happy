import { createHash } from "node:crypto";
import { getLogger } from "@rakazo/logging";

/** Bounds a base snapshot build: a fresh machine, the desktop install, and the save. */
export const BASE_SNAPSHOT_BUILD_TIMEOUT_MS = 30 * 60_000;
/** How long a process waits before building again after a failed build. */
const BASE_SNAPSHOT_RETRY_MS = 15 * 60_000;
/** How long a process waits to look again after a failed lookup or while another saves it. */
const BASE_SNAPSHOT_LOOKUP_RETRY_MS = 60_000;

/** A snapshot name that changes with the setup it captures, so older computers keep theirs. */
export function computerSnapshotName(setup: readonly string[]): string {
  const hash = createHash("sha256").update(setup.join("\0")).digest("hex").slice(0, 12);
  return `rakazo-computer-${hash}`;
}

/** Where a provider's saved base snapshot stands; `saving` means another process is saving it. */
export type BaseSnapshotStatus = "ready" | "saving" | "absent";

/**
 * One process's view of the snapshot new computers start from. Until it is ready, computers
 * install the desktop tools themselves while one build runs in the background.
 */
export class BaseSnapshotCache {
  private state?: "ready" | "missing";
  private build?: Promise<void>;
  private retryAt = 0;

  constructor(
    private readonly options: {
      provider: string;
      name: string;
      /** Builds and saves the snapshot; rejects when it could not. */
      build: () => Promise<unknown>;
      /** Warn that the snapshot is missing once per absence, rather than before every build. */
      warnMissingOnce: boolean;
    },
  ) {}

  /** The snapshot name once it is ready; `lookup` throws when the status is unknown. */
  async current(
    signal: AbortSignal,
    lookup: () => Promise<BaseSnapshotStatus>,
  ): Promise<string | undefined> {
    if (this.state === "ready") return this.options.name;
    if (this.build || Date.now() < this.retryAt) return undefined;
    let status: BaseSnapshotStatus;
    try {
      status = await lookup();
    } catch (error) {
      // A cancelled boot says nothing about the snapshot.
      if (signal.aborted) throw error;
      this.retryAt = Date.now() + BASE_SNAPSHOT_LOOKUP_RETRY_MS;
      return undefined;
    }
    if (status === "ready") {
      this.state = "ready";
      return this.options.name;
    }
    if (status === "saving") {
      this.retryAt = Date.now() + BASE_SNAPSHOT_LOOKUP_RETRY_MS;
      return undefined;
    }
    this.missing();
    return undefined;
  }

  /** The snapshot was removed since this process saw it: rebuild it. */
  lost(): void {
    this.state = undefined;
    this.missing();
  }

  private missing(): void {
    if (this.build) return;
    const { provider, name, warnMissingOnce } = this.options;
    if (!warnMissingOnce || this.state !== "missing") {
      this.state = "missing";
      getLogger().warn("sandbox.base_image", { provider, outcome: "missing", name });
    }
    const started = performance.now();
    this.build = this.options
      .build()
      .then(
        () => {
          this.state = "ready";
          getLogger().info("sandbox.base_image", {
            provider,
            outcome: "built",
            name,
            durationMs: Math.round(performance.now() - started),
          });
        },
        (error: unknown) => {
          this.retryAt = Date.now() + BASE_SNAPSHOT_RETRY_MS;
          getLogger().warn("sandbox.base_image", {
            provider,
            outcome: "build_failed",
            name,
            error,
          });
        },
      )
      .finally(() => {
        this.build = undefined;
      });
  }
}
