import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";

type CatalogRef = Pick<ConnectionCatalogItem, "connectorId" | "slug">;

export function catalogItemKey(item: CatalogRef) {
  return `${item.connectorId}:${item.slug}`;
}

/** Connected or still-authorizing accounts for one catalog app. */
export function catalogItemAccounts(connections: readonly Connection[], item: CatalogRef) {
  return connections.filter(
    (row) =>
      row.connectorId === item.connectorId &&
      row.provider === item.slug &&
      (row.status === "connected" || row.status === "pending"),
  );
}

export function isCatalogItemConnected(
  connections: readonly Connection[],
  item: ConnectionCatalogItem,
) {
  return (
    item.connected ||
    catalogItemAccounts(connections, item).some((row) => row.status === "connected")
  );
}

/** "Gmail", then numbered accounts, skipping names already connected or authorizing. */
export function nextCatalogAccountLabel(
  connections: readonly Connection[],
  item: ConnectionCatalogItem,
) {
  const accounts = catalogItemAccounts(connections, item);
  const names = new Set(accounts.map((row) => row.displayName));
  let number = accounts.filter((row) => row.status === "connected").length + 1;
  let label = number === 1 ? item.name : `${item.name} ${number}`;
  while (names.has(label)) {
    number += 1;
    label = `${item.name} ${number}`;
  }
  return label;
}

const CATALOG_CONNECT_POLL_ATTEMPTS = 45;
const CATALOG_CONNECT_POLL_MS = 2_000;

/**
 * Begin a catalog connection, open its authorization page, and wait for it to finish.
 * Platforms supply transport and URL opening; the flow itself stays identical everywhere.
 */
export async function connectCatalogItem(
  item: ConnectionCatalogItem,
  connections: readonly Connection[],
  deps: {
    begin: (input: {
      connectorId: string;
      provider: string;
      displayName: string;
    }) => Promise<{ connectionId: string; authorizationUrl: string | null }>;
    complete: (input: { connectionId: string }) => Promise<Connection>;
    openUrl: (url: string) => unknown;
    signal: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<
  { status: "connected"; row?: Connection } | { status: "pending" } | { status: "aborted" }
> {
  const stopped = () => deps.signal.aborted || deps.isCurrent?.() === false;
  const started = await deps.begin({
    connectorId: item.connectorId,
    provider: item.slug,
    displayName: nextCatalogAccountLabel(connections, item),
  });
  if (stopped()) return { status: "aborted" };
  if (started.authorizationUrl) await deps.openUrl(started.authorizationUrl);
  else if (item.noAuth) return { status: "connected" };
  return waitForConnection(started.connectionId, deps.complete, {
    signal: deps.signal,
    isCurrent: deps.isCurrent,
    attempts: CATALOG_CONNECT_POLL_ATTEMPTS,
  });
}

/**
 * Poll `connections/complete` until the connection is connected. A connection that was revoked
 * or no longer exists was superseded (a newer attempt, possibly on another device, or a removal),
 * so polling stops quietly as "aborted".
 */
export async function waitForConnection<Row extends { status: string }>(
  connectionId: string,
  complete: (input: { connectionId: string }) => Promise<Row>,
  options: { signal: AbortSignal; isCurrent?: () => boolean; attempts: number },
): Promise<{ status: "connected"; row: Row } | { status: "pending" } | { status: "aborted" }> {
  const stopped = () => options.signal.aborted || options.isCurrent?.() === false;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (stopped()) return { status: "aborted" };
    let row: Row | undefined;
    try {
      row = await complete({ connectionId });
    } catch (error) {
      if (isNotFound(error)) return { status: "aborted" };
    }
    if (stopped()) return { status: "aborted" };
    if (row?.status === "connected") return { status: "connected", row };
    if (row?.status === "revoked") return { status: "aborted" };
    await abortableDelay(CATALOG_CONNECT_POLL_MS, options.signal);
  }
  return stopped() ? { status: "aborted" } : { status: "pending" };
}

/** The server's NOT_FOUND code, not any 404 a proxy or an older server might send. */
function isNotFound(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "NOT_FOUND";
}
