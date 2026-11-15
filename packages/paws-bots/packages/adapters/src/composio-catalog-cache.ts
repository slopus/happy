export type ToolkitDirectoryEntry = {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
  /** No shared sign-in and no project setup for this app, so connecting it can only fail. */
  needsSignInSetup?: boolean;
};

export type ToolkitCatalogEntry = Omit<ToolkitDirectoryEntry, "needsSignInSetup"> & {
  connected: boolean;
};

export const COMPOSIO_DIRECTORY_TTL_MS = 60 * 60 * 1000;

export function mergeCatalogWithConnected(
  directory: ToolkitDirectoryEntry[],
  connectedSlugs: Iterable<string>,
  /** Slugs with any account, active or not; these stay listed even when sign-in needs setup. */
  accountSlugs: Iterable<string> = [],
): ToolkitCatalogEntry[] {
  const key = (slug: string) => slug.trim().toLowerCase();
  const connected = new Set([...connectedSlugs].map(key));
  const withAccount = new Set([...accountSlugs].map(key));
  return directory.flatMap(({ needsSignInSetup, ...item }) => {
    const isConnected = connected.has(key(item.slug));
    if (needsSignInSetup && !isConnected && !withAccount.has(key(item.slug))) return [];
    return [{ ...item, connected: isConnected }];
  });
}

/**
 * Coalesces directory loads and serves stale entries during refreshes. Failed
 * refreshes preserve stale entries for later retries; cold-load errors propagate.
 */
export function createToolkitDirectoryCache(opts?: { ttlMs?: number; now?: () => number }) {
  const ttlMs = opts?.ttlMs ?? COMPOSIO_DIRECTORY_TTL_MS;
  const now = opts?.now ?? Date.now;
  let entry: { items: ToolkitDirectoryEntry[]; fetchedAt: number } | undefined;
  let inflight: Promise<ToolkitDirectoryEntry[]> | undefined;

  async function load(loader: () => Promise<ToolkitDirectoryEntry[]>) {
    inflight ??= loader()
      .then((items) => {
        entry = { items, fetchedAt: now() };
        return items;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    peek(): ToolkitDirectoryEntry[] | undefined {
      return entry?.items;
    },
    async get(loader: () => Promise<ToolkitDirectoryEntry[]>): Promise<ToolkitDirectoryEntry[]> {
      if (!entry) return load(loader);
      if (now() - entry.fetchedAt < ttlMs) return entry.items;
      if (!inflight) {
        // Keep stale items on failure; load clears inflight so a later read can retry.
        void load(loader).catch(() => undefined);
      }
      return entry.items;
    },
    invalidate() {
      entry = undefined;
    },
  };
}

export const composioToolkitDirectory = createToolkitDirectoryCache();
