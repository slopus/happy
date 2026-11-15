/** Deployment-wide catalog probing switch; tests opt in with injected transports. */
export function liveModelCatalogEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.RAKAZO_LIVE_MODEL_CATALOG?.trim().toLowerCase() !== "off";
}

export type CatalogFetch<T> = { attempted: false } | { attempted: true; models: T[] | undefined };
type Entry<T> = { models?: T[]; expiresAt: number; fetchedAt: number };

/** Shared SWR lifecycle for account and API-key catalogs. Invalidation fences in-flight writes. */
export class LiveCatalogCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T[] | undefined>>();
  constructor(
    private readonly options: {
      now?: () => number;
      ttlMs: number;
      failureTtlMs: number;
      waitMs: number;
      deadlineMs: number;
      staleMaxAgeMs: number;
      maxEntries: number;
    },
  ) {}

  invalidate(prefix: string): void {
    for (const map of [this.entries, this.inflight]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
  }

  async read(
    key: string,
    fetchModels: (signal: AbortSignal) => Promise<CatalogFetch<T>>,
    waitMs = this.options.waitMs,
  ): Promise<T[] | undefined> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return this.trusted(entry);
    let pending = this.inflight.get(key);
    if (!pending) {
      if (this.inflight.size >= this.options.maxEntries) return entry && this.trusted(entry);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), this.options.deadlineMs);
      const aborted = new Promise<CatalogFetch<T>>((resolve) =>
        controller.signal.addEventListener(
          "abort",
          () => resolve({ attempted: true, models: undefined }),
          { once: true },
        ),
      );
      const work = (async () => fetchModels(controller.signal))().catch(
        (): CatalogFetch<T> => ({ attempted: true, models: undefined }),
      );
      pending = Promise.race([work, aborted]).then((outcome) => {
        clearTimeout(deadline);
        if (this.inflight.get(key) !== pending) return undefined;
        this.inflight.delete(key);
        if (!outcome.attempted) return undefined;
        const models = outcome.models?.length ? outcome.models : undefined;
        const next = models
          ? { models, fetchedAt: this.now(), expiresAt: this.now() + this.options.ttlMs }
          : {
              models: entry && this.trusted(entry),
              fetchedAt: entry?.fetchedAt ?? this.now(),
              expiresAt: this.now() + this.options.failureTtlMs,
            };
        if (!this.entries.has(key) && this.entries.size >= this.options.maxEntries)
          this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, next);
        return models;
      });
      this.inflight.set(key, pending);
    }
    if (entry || waitMs === 0) return entry && this.trusted(entry);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), waitMs);
      void pending.then((models) => {
        clearTimeout(timer);
        resolve(models);
      });
    });
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private trusted(entry: Entry<T>) {
    return entry.fetchedAt + this.options.staleMaxAgeMs > this.now() ? entry.models : undefined;
  }
}
