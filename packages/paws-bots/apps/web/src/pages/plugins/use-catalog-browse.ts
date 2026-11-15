import { useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem, PluginMarketplaceEntry } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  filterConnectionCatalogItems,
  integrationCatalogsReady,
  managedAppFor,
  matchesPluginQuery,
  matchesWordPrefixes,
  OTHER_PLUGINS,
  PLUGIN_CATEGORIES,
} from "@rakazo/core";
import { useMemo, useState } from "react";
import type { PluginConnections } from "./use-plugin-connections";

const NO_PLUGINS: PluginMarketplaceEntry[] = [];
export const PLUGIN_PAGE_SIZE = 24;

export type CatalogBrowse = ReturnType<typeof useCatalogBrowse>;

/**
 * The browse page's search, category, and paging, and what they pick from the app catalog and
 * the plugin marketplace.
 */
export function useCatalogBrowse({
  catalog,
  catalogLoaded,
  loadError,
  pluginCatalog,
}: {
  catalog: ConnectionCatalogItem[];
  catalogLoaded: boolean;
  loadError: string | null;
  pluginCatalog: PluginConnections["pluginCatalog"];
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [category, setCategory] = useState<string | null>(null);
  const [pluginCount, setPluginCount] = useState(PLUGIN_PAGE_SIZE);

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();

  const visible = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  // Apps whose name starts with the query come before plugins; mid-word matches trail them.
  const strongMatches = showFeatured
    ? []
    : visible.filter((item) => matchesWordPrefixes(item.name, query));
  const weakMatches = showFeatured
    ? visible
    : visible.filter((item) => !matchesWordPrefixes(item.name, query));
  const rendered = weakMatches.slice(0, visibleCount);

  const catalogEntries = pluginCatalog.data?.entries ?? NO_PLUGINS;
  // An empty managed catalog says nothing about plugins that are still loading or unavailable.
  const catalogsReady = integrationCatalogsReady({
    catalogLoaded,
    catalogFailed: !!loadError,
    pluginsLoaded: pluginCatalog.isSuccess,
    pluginsUnavailable: !!pluginCatalog.data?.unavailableRegistries.length,
  });
  // One row per brand: a plugin for a managed app lends that app its skills instead of being
  // listed again. Skill packs with nothing to connect belong to Skills, not here.
  const { plugins, pluginForApp } = useMemo(() => {
    const forApp = new Map<string, PluginMarketplaceEntry>();
    const listed: PluginMarketplaceEntry[] = [];
    for (const entry of catalogEntries) {
      const app = managedAppFor(entry, catalog);
      if (app) {
        if (entry.skillCount && !forApp.has(catalogItemKey(app)))
          forApp.set(catalogItemKey(app), entry);
      } else if (entry.hasConnector) listed.push(entry);
    }
    return { plugins: listed, pluginForApp: forApp };
  }, [catalog, catalogEntries]);
  const categoryLabels: Record<PluginCategory, string> = {
    productivity: t`Productivity`,
    communication: t`Communication`,
    sales: t`Sales & CRM`,
    marketing: t`Marketing`,
    finance: t`Finance`,
    people: t`Recruiting & HR`,
    design: t`Design`,
    code: t`Developer`,
    data: t`Data`,
    ops: t`Security & Ops`,
  };
  const categoryLabel = (name: string) => categoryLabels[name as PluginCategory] ?? name;
  // Managed apps standing in for a plugin keep that plugin's category, so a category lists them too.
  const mergedBrands = catalog.flatMap((item) => {
    const entry = pluginForApp.get(catalogItemKey(item));
    return entry ? [{ item, entry }] : [];
  });
  const categories: string[] = PLUGIN_CATEGORIES.filter(
    (name) =>
      plugins.some((entry) => entry.category === name) ||
      mergedBrands.some(({ entry }) => entry.category === name),
  );
  const brandMatches = category
    ? mergedBrands.filter(
        ({ item, entry }) =>
          entry.category === (category === OTHER_PLUGINS ? null : category) &&
          (matchesWordPrefixes(item.name, query) ||
            matchesPluginQuery(entry, query, categoryLabel(entry.category ?? ""))),
      )
    : [];
  const searching = query.trim().length > 0;
  const pluginMatches = plugins.filter(
    (entry) =>
      (!category || entry.category === (category === OTHER_PLUGINS ? null : category)) &&
      matchesPluginQuery(entry, query, entry.category ? categoryLabel(entry.category) : ""),
  );

  return {
    query,
    setQuery,
    visibleCount,
    setVisibleCount,
    category,
    setCategory,
    pluginCount,
    setPluginCount,
    featuredTiles,
    showFeatured,
    visible,
    strongMatches,
    weakMatches,
    rendered,
    catalogEntries,
    catalogsReady,
    plugins,
    pluginForApp,
    categoryLabel,
    categories,
    brandMatches,
    searching,
    pluginMatches,
  };
}
