import type { ConnectionCatalogItem } from "@rakazo/contracts";

export const FEATURED_CONNECTOR_IDS = [
  "gmail",
  "google-calendar",
  "google-drive",
  "slack",
  "notion",
] as const;

export type FeaturedConnectorId = (typeof FEATURED_CONNECTOR_IDS)[number];

export const FEATURED_CONNECTOR_LABELS: Record<FeaturedConnectorId, string> = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-drive": "Google Drive",
  slack: "Slack",
  notion: "Notion",
};

const FEATURED_ALIASES: Record<FeaturedConnectorId, readonly string[]> = {
  gmail: ["gmail", "googlemail", "google mail"],
  "google-calendar": ["googlecalendar", "google calendar", "google_calendar", "gcal"],
  "google-drive": ["googledrive", "google drive", "google_drive", "gdrive"],
  slack: ["slack", "slackbot"],
  notion: ["notion", "notion.so"],
};

export type FeaturedConnectorTile = {
  id: FeaturedConnectorId;
  label: string;
  item?: ConnectionCatalogItem;
  /** Catalog has items but none matched this featured connector. */
  missing: boolean;
};

/** Keep catalog screens responsive even when a provider exposes thousands of apps. */
export const CONNECTION_CATALOG_PAGE_SIZE = 60;

function normalizeConnectorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchFeaturedConnectorId(value: string): FeaturedConnectorId | null {
  const normalized = normalizeConnectorKey(value);
  if (!normalized) return null;
  for (const id of FEATURED_CONNECTOR_IDS) {
    if (FEATURED_ALIASES[id].some((alias) => normalizeConnectorKey(alias) === normalized)) {
      return id;
    }
  }
  return null;
}

export function featuredConnectorProvidersMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const leftId = matchFeaturedConnectorId(left);
  const rightId = matchFeaturedConnectorId(right);
  return leftId !== null && leftId === rightId;
}

export function resolveFeaturedCatalogItem(
  id: FeaturedConnectorId,
  catalog: readonly ConnectionCatalogItem[],
): ConnectionCatalogItem | undefined {
  for (const item of catalog) {
    if (matchFeaturedConnectorId(item.slug) === id) return item;
    if (matchFeaturedConnectorId(item.name) === id) return item;
  }
  return undefined;
}

export function buildFeaturedConnectorTiles(
  catalog: readonly ConnectionCatalogItem[],
): FeaturedConnectorTile[] {
  const hasCatalog = catalog.length > 0;
  return FEATURED_CONNECTOR_IDS.map((id) => {
    const item = hasCatalog ? resolveFeaturedCatalogItem(id, catalog) : undefined;
    return {
      id,
      label: FEATURED_CONNECTOR_LABELS[id],
      item,
      missing: hasCatalog && !item,
    };
  });
}

export function filterConnectionCatalogItems(
  catalog: readonly ConnectionCatalogItem[],
  query: string,
): ConnectionCatalogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return catalog.filter(
      (item) =>
        matchFeaturedConnectorId(item.slug) === null &&
        matchFeaturedConnectorId(item.name) === null,
    );
  }
  return catalog.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) ||
      item.slug.toLowerCase().includes(needle) ||
      item.connectorId.toLowerCase().includes(needle),
  );
}

/** Loading or unavailable catalogs cannot establish that there are no matching apps. */
export function integrationCatalogsReady({
  catalogLoaded,
  catalogFailed,
  pluginsLoaded,
  pluginsUnavailable,
}: {
  catalogLoaded: boolean;
  catalogFailed: boolean;
  pluginsLoaded: boolean;
  pluginsUnavailable: boolean;
}): boolean {
  return catalogLoaded && !catalogFailed && pluginsLoaded && !pluginsUnavailable;
}
