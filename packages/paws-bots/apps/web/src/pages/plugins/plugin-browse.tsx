import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem, PluginMarketplaceEntry } from "@rakazo/contracts";
import { CATALOG_SEARCH_QUERY_MAX_LENGTH, SUBMIT_PLUGIN_URL } from "@rakazo/contracts";
import {
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  isRecommendedPlugin,
  managedAppFor,
  OTHER_PLUGINS,
} from "@rakazo/core";
import { Button, SectionHeading, Spinner } from "@rakazo/ui-web";
import { ArrowUpRight, Search } from "lucide-react";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import {
  PluginRow,
  pluginSelection,
  ROW_BUTTON,
  ROW_HOVER,
  ROW_SHELL,
} from "../../components/integrations/plugin-marketplace";
import type { TileContext } from "./parts";
import { CatalogTile } from "./parts";
import type { CatalogBrowse } from "./use-catalog-browse";
import { PLUGIN_PAGE_SIZE } from "./use-catalog-browse";
import type { PluginConnections } from "./use-plugin-connections";

const SECTION_SIZE = 6;

/** The browse page under the search: featured apps, plugin sections or matches, and more apps. */
export function PluginBrowse({
  browse,
  state,
  tileContext,
  onOpenPlugin,
  onSearchPublic,
}: {
  browse: CatalogBrowse;
  state: PluginConnections;
  tileContext: TileContext;
  onOpenPlugin: (selection: PluginSelection) => void;
  /** Opens the public MCP catalog searched for the query. */
  onSearchPublic: (query: string) => void;
}) {
  const { t } = useLingui();
  const { catalogLoaded, catalog, pluginCatalog, pluginInstalls } = state;
  const {
    query,
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
    categoryLabel,
    categories,
    brandMatches,
    searching,
    pluginMatches,
  } = browse;
  const installedPlugin = (installedSource: string) =>
    pluginInstalls.find((row) => row.source === installedSource);

  function catalogTile(
    item: ConnectionCatalogItem,
    label: string,
    logo?: string | null,
    opts?: { tileTestId?: boolean },
  ) {
    return (
      <CatalogTile
        key={catalogItemKey(item)}
        item={item}
        label={label}
        logo={logo}
        tileTestId={opts?.tileTestId}
        context={tileContext}
      />
    );
  }

  function renderPluginRow(entry: PluginMarketplaceEntry) {
    const selection = pluginSelection(entry);
    return (
      <PluginRow
        key={entry.id}
        name={entry.displayName}
        description={entry.description}
        logo={entry.logo}
        site={selection.site}
        installed={Boolean(installedPlugin(entry.installedSource))}
        onOpen={() => onOpenPlugin(selection)}
      />
    );
  }

  function renderPluginSections() {
    if (pluginCatalog.isPending)
      return (
        <div className="grid place-items-center py-8">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading plugins…`} />
        </div>
      );
    const unavailable =
      pluginCatalog.error || pluginCatalog.data?.unavailableRegistries.length ? (
        <div role="alert" className="mt-6 flex items-center gap-3 text-body text-muted-foreground">
          <Trans>Some plugins could not be loaded.</Trans>
          <Button variant="outline" size="sm" onClick={() => void pluginCatalog.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null;
    return (
      <>
        {unavailable}
        {renderPluginResults()}
      </>
    );
  }

  function renderPluginResults() {
    if (category || searching)
      return pluginMatches.length || brandMatches.length ? (
        <section data-testid="plugin-results" className="mt-2">
          <div className="grid grid-cols-2 gap-2">
            {brandMatches.map(({ item }) => catalogTile(item, item.name, item.logo))}
            {pluginMatches.slice(0, pluginCount).map(renderPluginRow)}
          </div>
          {pluginCount < pluginMatches.length ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPluginCount((count) => count + PLUGIN_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </section>
      ) : null;
    // A recommended brand this deployment already offers as a managed app is listed as that app.
    const recommended = catalogEntries
      .filter(isRecommendedPlugin)
      .map((entry) => ({ entry, item: managedAppFor(entry, catalog) }))
      .filter(({ entry, item }) => item || entry.hasConnector)
      .slice(0, SECTION_SIZE);
    const uncategorized = plugins.filter((entry) => !entry.category);
    const sections: Array<[string, string, PluginMarketplaceEntry[]]> = [
      ...categories.map((name): [string, string, PluginMarketplaceEntry[]] => [
        name,
        categoryLabel(name),
        plugins.filter((entry) => entry.category === name),
      ]),
      ...(uncategorized.length
        ? [[OTHER_PLUGINS, t`More`, uncategorized] as [string, string, PluginMarketplaceEntry[]]]
        : []),
    ].filter(([, , entries]) => entries.length);
    return (
      <>
        {recommended.length ? (
          <section data-testid="plugin-section" className="mt-8">
            <SectionHeading as="h2" className="mb-2 px-2.5">
              <Trans>Recommended</Trans>
            </SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              {recommended.map(({ entry, item }) =>
                item ? catalogTile(item, item.name, item.logo) : renderPluginRow(entry),
              )}
            </div>
          </section>
        ) : null}
        {sections.map(([name, label, entries]) => (
          <section key={name} data-testid="plugin-section" className="mt-8">
            <div className="mb-2 flex items-center justify-between px-2.5">
              <SectionHeading as="h2">{label}</SectionHeading>
              {entries.length > SECTION_SIZE ? (
                <Button variant="text" size="sm" onClick={() => setCategory(name)}>
                  <Trans>View all</Trans>
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {entries.slice(0, SECTION_SIZE).map(renderPluginRow)}
            </div>
          </section>
        ))}
      </>
    );
  }

  /** Nothing leaves for the public catalog until the person picks this row. */
  function renderPublicCatalogRow(query: string) {
    return (
      <div className={`mt-2 ${ROW_SHELL} ${ROW_HOVER}`}>
        <button
          type="button"
          className={ROW_BUTTON}
          onClick={() => {
            onSearchPublic(query);
          }}
        >
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border/60 bg-favicon-plate text-muted-foreground">
            <Search className="size-4" />
          </div>
          <span className="min-w-0 flex-1 truncate text-body-lg font-medium text-foreground">
            <Trans>Search MCP servers for “{query}”</Trans>
          </span>
        </button>
      </div>
    );
  }

  return (
    <>
      {catalogLoaded && showFeatured && !category ? (
        <div className="mb-6" data-testid="featured-connectors">
          {catalog.length === 0 ? (
            !catalogsReady || plugins.length ? null : (
              <p className="text-body leading-6 text-muted-foreground/80">
                <Trans>Configure a plugin catalog on the server to connect apps.</Trans>
              </p>
            )
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {featuredTiles.map((tile) => {
                const item = tile.item;
                const key = item ? catalogItemKey(item) : tile.id;
                const disabled = tile.missing || !item;
                if (item && !tile.missing) {
                  // Featured is the stable hit target for connection-tile-* in E2E.
                  return catalogTile(item, tile.label, item.logo, {
                    tileTestId: true,
                  });
                }
                return (
                  <div
                    key={key}
                    className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${
                      disabled ? "opacity-70" : ""
                    }`}
                  >
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-body font-semibold text-foreground">
                      {tile.label[0]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-lg font-medium text-foreground">
                        {tile.label}
                      </div>
                      {disabled ? (
                        <div className="truncate text-body-sm text-muted-foreground">
                          <Trans>Not in the plugin catalog</Trans>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {catalogsReady &&
      visible.length === 0 &&
      !showFeatured &&
      !pluginMatches.length &&
      !brandMatches.length ? (
        <p className="text-muted-foreground/80">
          <Trans>No apps match your search.</Trans>
        </p>
      ) : null}
      {showFeatured ? (
        <>
          {renderPluginSections()}
          {catalogLoaded && catalog.length > 0 && !category ? (
            <SectionHeading as="h2" className="mt-8 mb-2 px-2.5">
              <Trans>More apps</Trans>
            </SectionHeading>
          ) : null}
          {visible.length > 0 && !category ? (
            <div className="grid grid-cols-2 gap-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, {
                  // Avoid duplicate connection-tile-* ids while featured is also shown.
                  tileTestId: !showFeatured,
                }),
              )}
            </div>
          ) : null}
          {rendered.length < visible.length && !category ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {strongMatches.length > 0 && !category ? (
            <div className="mb-2 grid grid-cols-2 gap-2">
              {strongMatches.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {renderPluginSections()}
          {rendered.length > 0 && !category ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {rendered.map((item) =>
                catalogTile(item, item.name, item.logo, { tileTestId: true }),
              )}
            </div>
          ) : null}
          {rendered.length < weakMatches.length && !category ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)}
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          ) : null}
          {query.trim().length >= 2 &&
          query.trim().length <= CATALOG_SEARCH_QUERY_MAX_LENGTH &&
          !category
            ? renderPublicCatalogRow(query.trim())
            : null}
        </>
      )}
      {catalogLoaded && !category ? (
        <div className="mt-10 flex justify-center">
          <a
            href={SUBMIT_PLUGIN_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
          >
            <Trans>Submit a plugin</Trans>
            <ArrowUpRight size={14} />
          </a>
        </div>
      ) : null}
    </>
  );
}
