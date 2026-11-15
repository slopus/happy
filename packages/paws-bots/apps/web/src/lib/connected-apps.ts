import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { matchFeaturedConnectorId } from "@rakazo/core";

function isFamiliarApp(item: ConnectionCatalogItem) {
  return (
    matchFeaturedConnectorId(item.slug) !== null ||
    matchFeaturedConnectorId(item.name) !== null ||
    item.slug.toLowerCase() === "github"
  );
}

/** Connected apps, or familiar artwork-first suggestions from the loaded catalog. */
export function connectedAppMarks(
  catalog: readonly ConnectionCatalogItem[],
  connections: readonly Connection[],
) {
  const connected = catalog.filter(
    (item) =>
      item.connected ||
      connections.some(
        (row) =>
          row.status === "connected" &&
          row.connectorId === item.connectorId &&
          row.provider.toLowerCase() === item.slug.toLowerCase(),
      ),
  );
  const apps = [...(connected.length ? connected : catalog)]
    .sort(
      (a, b) =>
        Number(Boolean(b.logo)) - Number(Boolean(a.logo)) ||
        (connected.length ? 0 : Number(isFamiliarApp(b)) - Number(isFamiliarApp(a))),
    )
    .filter((item, index, apps) => apps.findIndex((app) => app.name === item.name) === index);
  const initials = new Set<string>();
  const preferred = apps.filter((app) => {
    if (app.logo) return true;
    const initial = app.name[0]?.toUpperCase() ?? "";
    if (initials.has(initial)) return false;
    initials.add(initial);
    return true;
  });
  return [...preferred, ...apps.filter((app) => !preferred.includes(app))]
    .slice(0, 3)
    .map(({ name, logo }) => ({ name, logo }));
}
