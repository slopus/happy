import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  ConnectionCatalogItem,
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpSourcePreset,
} from "@rakazo/contracts";
import { mcpServerConnection } from "@rakazo/contracts";
import {
  CONNECTION_CATALOG_PAGE_SIZE,
  catalogItemKey,
  installedPluginParts,
  managedAppFor,
} from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Spinner,
} from "@rakazo/ui-web";
import { ChevronDown, ChevronRight, LayoutTemplate, X } from "lucide-react";
import { useMemo, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import type {
  ManagedAppLink,
  PluginSelection,
} from "../components/integrations/plugin-marketplace";
import { PluginDetail, pluginSelection } from "../components/integrations/plugin-marketplace";
import { reachesOtherSpaces, useOwnSpaces } from "../components/integrations/space-availability";
import type { connectedAppMarks } from "../lib/connected-apps";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { AddMenu } from "./plugins/add-menu";
import { ConnectorDetail } from "./plugins/connector-detail";
import { DomainSearch, useDomainSearch } from "./plugins/domain-search";
import { GithubImport } from "./plugins/github-import";
import { ManageView } from "./plugins/manage-view";
import type { TileContext } from "./plugins/parts";
import { ViewTitle } from "./plugins/parts";
import { PluginBrowse } from "./plugins/plugin-browse";
import type { SourceKind } from "./plugins/source-form";
import { SourceFormView, useSourceForm } from "./plugins/source-form";
import { PLUGIN_PAGE_SIZE, useCatalogBrowse } from "./plugins/use-catalog-browse";
import { usePluginConnections } from "./plugins/use-plugin-connections";

type OverlayView = "browse" | "manage" | "github" | "source" | "browseMcp" | "domain";

const CHIP_COUNT = 6;

export function PluginsOverlay({
  onConnectedAppsChange,
  onClose,
  onOpenMcp,
  onOpenTemplates,
  activeBotId,
}: {
  onConnectedAppsChange?: (apps: ReturnType<typeof connectedAppMarks>) => void;
  onClose: () => void;
  onOpenMcp?: () => void;
  onOpenTemplates?: () => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const [confirmingSource, setConfirmingSource] = useState<string | null>(null);
  const spaceCount = useOwnSpaces().length;
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [view, setView] = useState<OverlayView>("browse");
  const [publicCatalogQuery, setPublicCatalogQuery] = useState("");
  // Where a source form returns: the domain search that prefilled it, or browse.
  const [sourceBack, setSourceBack] = useState<OverlayView>("browse");
  const [plugin, setPlugin] = useState<PluginSelection | null>(null);
  const [gitSource, setGitSource] = useState("");
  const [detailKey, setDetailKey] = useState<{
    connectorId: string;
    slug: string;
  } | null>(null);
  const state = usePluginConnections({
    activeBotId,
    detailKey,
    closeDetail,
    onConnectedAppsChange,
  });
  const {
    mcpServers,
    sourcePresets,
    integrations,
    catalogLoaded,
    loading,
    catalog,
    sources,
    pluginInstalls,
    assigned,
    catalogFeedEnabled,
    loadError,
    updateIntegrations,
    refresh,
    pending,
    setPending,
    catalogError,
    setCatalogError,
    itemConnected,
    connect,
  } = state;
  const browse = useCatalogBrowse({
    catalog,
    catalogLoaded,
    loadError,
    pluginCatalog: state.pluginCatalog,
  });
  const {
    query,
    setQuery,
    setVisibleCount,
    category,
    setCategory,
    setPluginCount,
    catalogEntries,
    pluginForApp,
    categoryLabel,
    categories,
  } = browse;
  const sourceForm = useSourceForm();
  const domainSearch = useDomainSearch();

  const detailItem = useMemo(() => {
    if (!detailKey) return null;
    return (
      catalog.find(
        (entry) => entry.connectorId === detailKey.connectorId && entry.slug === detailKey.slug,
      ) ?? null
    );
  }, [catalog, detailKey]);

  const pluginServers = (install: CapabilityInstall | undefined) =>
    install ? mcpServers.filter((server) => server.installId === install.id) : [];
  const standaloneServers = mcpServers.filter((server) => !server.installId);
  const connectedItems = catalog.filter((item) => itemConnected(item));
  // Skills live in their own dialog, so only installs with a connector count as apps here.
  const connectorInstalls = pluginInstalls.filter((install) =>
    installedPluginParts(install.config).includes("connector"),
  );
  const appCount =
    connectedItems.length + standaloneServers.length + sources.length + connectorInstalls.length;
  const readyInstalls = connectorInstalls.filter((install) => {
    const servers = pluginServers(install);
    return (
      servers.length > 0 && servers.every((server) => mcpServerConnection(server) === "connected")
    );
  });
  const connectedCount =
    connectedItems.length +
    standaloneServers.filter((server) => mcpServerConnection(server) === "connected").length +
    sources.length +
    readyInstalls.length;
  const connectedMarks = [
    ...connectedItems.map((item) => ({
      key: catalogItemKey(item),
      name: item.name,
      logo: item.logo,
    })),
    ...readyInstalls.map((install) => {
      const entry = catalogEntries.find((row) => row.installedSource === install.source);
      return { key: install.id, name: entry?.displayName ?? install.name, logo: entry?.logo };
    }),
  ].slice(0, 4);

  const browsing = !plugin && !detailItem && view === "browse";

  function openPlugin(selection: PluginSelection) {
    setCatalogError(null);
    setPlugin(selection);
  }

  /** A managed app whose brand also has a plugin opens one page with its skills. */
  function openApp(item: ConnectionCatalogItem) {
    const entry = pluginForApp.get(catalogItemKey(item));
    if (entry) openPlugin(pluginSelection(entry));
    else openDetail(item);
  }

  const appForPlugin = (selection: PluginSelection) => {
    const entry = catalogEntries.find((row) => row.installedSource === selection.installedSource);
    return entry ? managedAppFor(entry, catalog) : undefined;
  };

  function installedSelection(install: CapabilityInstall): PluginSelection {
    const entry = catalogEntries.find((row) => row.installedSource === install.source);
    return entry
      ? pluginSelection(entry)
      : { source: install.source, installedSource: install.source, name: install.name };
  }

  function managedLink(selection: PluginSelection): ManagedAppLink | undefined {
    const item = appForPlugin(selection);
    if (!item) return undefined;
    return {
      name: item.name,
      logo: item.logo,
      connected: itemConnected(item),
      connecting: pending === catalogItemKey(item),
      onConnect: () => void connect(item),
      onManage: () => {
        setPlugin(null);
        openDetail(item);
      },
    };
  }

  function openDetail(item: ConnectionCatalogItem) {
    setCatalogError(null);
    setDetailKey({ connectorId: item.connectorId, slug: item.slug });
  }

  function closeDetail() {
    setDetailKey(null);
  }

  const tileContext: TileContext = {
    connections: state,
    pluginForApp,
    onOpenApp: openApp,
    onOpenDetail: openDetail,
  };

  function beginSource(kind: SourceKind, preset: McpSourcePreset | null = null) {
    setPlugin(null);
    setDetailKey(null);
    setSourceBack("browse");
    setView("source");
    sourceForm.start(kind, preset);
    setSourceError(null);
  }

  function beginCatalogSurface(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
  ) {
    if (!surface.source || (surface.kind !== "mcp" && surface.kind !== "openapi")) return;
    setSourceBack("domain");
    setView("source");
    sourceForm.startFromCatalog(result, surface, surface.source);
    setSourceError(null);
  }

  async function installSource() {
    const { sourceKind, sourcePreset, sourceName, sourceUrl, credential, authType, authName } =
      sourceForm;
    if (!sourceKind) return;
    setSourceError(null);
    setPending("install-source");
    try {
      const auth = {
        type: authType,
        ...(authType === "header" ? { name: authName.trim() } : {}),
      };
      await rpc.capabilities.install({
        kind: sourceKind,
        name:
          sourceName.trim() ||
          (sourcePreset?.name ?? (sourceKind === "graphql" ? "GraphQL" : "Custom connector")),
        source: sourceUrl.trim(),
        credential: credential.trim() || undefined,
        config: sourcePreset
          ? { preset: sourcePreset.id }
          : sourceKind === "api"
            ? { openApi: true, auth }
            : sourceKind === "graphql"
              ? { auth }
              : { preset: "custom", auth },
      });
      sourceForm.setCredential("");
      sourceForm.setSourceKind(null);
      setView("manage");
      await refresh();
    } catch (err) {
      setSourceError(errorText(err, t`Could not install connector`));
    } finally {
      setPending(null);
    }
  }

  async function removeSource(install: CapabilityInstall) {
    if (reachesOtherSpaces(install.availability, spaceCount) && confirmingSource !== install.id) {
      setConfirmingSource(install.id);
      return;
    }
    setConfirmingSource(null);
    setPending(install.id);
    setSourceError(null);
    try {
      await rpc.capabilities.remove({ id: install.id });
      await updateIntegrations((current) => ({
        ...current,
        sources: current.sources.filter((source) => source.id !== install.id),
      }));
    } catch (err) {
      setSourceError(errorText(err, t`Could not remove connector`));
    } finally {
      setPending(null);
    }
  }

  function openAddView(next: OverlayView) {
    setPlugin(null);
    setDetailKey(null);
    setSourceError(null);
    setView(next);
  }

  function leaveSource() {
    sourceForm.close();
    setSourceError(null);
    setView(sourceBack);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="2xl" className="bg-card">
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <div className="flex items-center gap-2">
            {browsing && appCount > 0 ? (
              <Button
                variant="ghost"
                className="-my-1 h-9 gap-2.5 px-2.5 text-body text-muted-foreground"
                onClick={() => setView("manage")}
              >
                <span aria-hidden className="flex -space-x-1.5">
                  {connectedMarks.map((mark) => (
                    <span key={mark.key} className="rounded-[9px] ring-2 ring-card">
                      {mark.logo ? (
                        <img
                          src={mark.logo}
                          alt=""
                          className="h-6 w-6 rounded-lg bg-favicon-plate object-contain p-0.5"
                        />
                      ) : (
                        <span className="grid h-6 w-6 place-items-center rounded-lg border border-border/60 bg-favicon-plate text-caption font-semibold text-foreground">
                          {mark.name[0]?.toUpperCase()}
                        </span>
                      )}
                    </span>
                  ))}
                </span>
                <Plural value={connectedCount} one="# connected" other="# connected" />
                <ChevronRight />
              </Button>
            ) : null}
            {browsing && onOpenTemplates ? (
              <Button
                variant="ghost"
                className="-my-1 h-9 gap-2 px-2.5 text-body text-muted-foreground"
                data-testid="open-bot-templates"
                onClick={onOpenTemplates}
              >
                <LayoutTemplate />
                <Trans>Templates</Trans>
              </Button>
            ) : null}
            {browsing || view === "manage" ? (
              <AddMenu
                presets={sourcePresets}
                onGithub={() => openAddView("github")}
                onSource={beginSource}
                onBrowseMcp={() => {
                  setPublicCatalogQuery("");
                  openAddView("browseMcp");
                }}
                onDomainSearch={catalogFeedEnabled ? () => openAddView("domain") : undefined}
                onOpenMcp={onOpenMcp}
              />
            ) : null}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
            >
              <X />
            </DialogClose>
          </div>
        </DialogHeader>

        {browsing ? (
          <div className="space-y-4 px-8 pt-4">
            <Input
              disabled={loading}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
              aria-label={t`Search apps`}
              placeholder={t`Search apps`}
              className="h-11 rounded-xl px-4 md:text-body-lg"
            />
            {categories.length >= 2 || category ? (
              <div className="flex flex-wrap gap-2" data-testid="integration-categories">
                {[null, ...categories.slice(0, CHIP_COUNT)].map((name) => (
                  <Button
                    key={name ?? "all"}
                    type="button"
                    size="sm"
                    variant={category === name ? "default" : "secondary"}
                    aria-pressed={category === name}
                    className="h-8 rounded-full px-3.5 text-body-sm"
                    onClick={() => {
                      setCategory(name);
                      setPluginCount(PLUGIN_PAGE_SIZE);
                    }}
                  >
                    {name ? categoryLabel(name) : <Trans>All</Trans>}
                  </Button>
                ))}
                {categories.length > CHIP_COUNT ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            category && !categories.slice(0, CHIP_COUNT).includes(category)
                              ? "default"
                              : "secondary"
                          }
                          className="h-8 rounded-full px-3.5 text-body-sm"
                        />
                      }
                    >
                      {category && !categories.slice(0, CHIP_COUNT).includes(category) ? (
                        categoryLabel(category)
                      ) : (
                        <Trans>More</Trans>
                      )}
                      <ChevronDown />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-auto">
                      {categories.slice(CHIP_COUNT).map((name) => (
                        <DropdownMenuItem
                          key={name}
                          onClick={() => {
                            setCategory(name);
                            setPluginCount(PLUGIN_PAGE_SIZE);
                          }}
                        >
                          {categoryLabel(name)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="grid flex-1 place-items-center" aria-busy="true">
            <Spinner
              className="size-5 text-muted-foreground"
              aria-label={t`Loading integrations…`}
            />
          </div>
        ) : null}

        <div
          id="integration-list"
          hidden={loading}
          className="rk-scroll flex-1 overflow-y-auto px-8 py-6"
        >
          {catalogError || loadError ? (
            <div className="mb-4 flex items-center gap-3">
              <p className="text-body text-destructive">{catalogError ?? loadError}</p>
              {!catalogLoaded || (loadError && !catalogError) ? (
                <Button variant="outline" size="sm" onClick={() => void integrations.refetch()}>
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}

          {plugin ? (
            <PluginDetail
              key={plugin.installedSource}
              selection={plugin}
              installs={pluginInstalls}
              servers={mcpServers}
              assigned={assigned}
              activeBotId={activeBotId}
              managed={managedLink(plugin)}
              onBack={() => setPlugin(null)}
              onChanged={refresh}
            />
          ) : detailItem ? (
            <ConnectorDetail item={detailItem} state={state} onBack={closeDetail} />
          ) : view === "manage" ? (
            <ManageView
              state={state}
              tileContext={tileContext}
              connectedItems={connectedItems}
              connectorInstalls={connectorInstalls}
              standaloneServers={standaloneServers}
              appCount={appCount}
              sourceError={sourceError}
              confirmingSource={confirmingSource}
              onRemoveSource={(install) => void removeSource(install)}
              onOpenMcp={onOpenMcp}
              installedSelection={installedSelection}
              pluginServers={pluginServers}
              onOpenPlugin={openPlugin}
              onBack={() => setView("browse")}
            />
          ) : view === "github" ? (
            <GithubImport
              value={gitSource}
              onChange={setGitSource}
              onBack={() => setView("browse")}
              onPreview={openPlugin}
            />
          ) : view === "source" ? (
            <SourceFormView
              form={sourceForm}
              installing={pending === "install-source"}
              sourceError={sourceError}
              onBack={leaveSource}
              onSubmit={() => void installSource()}
            />
          ) : view === "domain" ? (
            <DomainSearch
              state={domainSearch}
              onBack={() => setView("browse")}
              onPick={beginCatalogSurface}
            />
          ) : view === "browseMcp" ? (
            <div className="space-y-6">
              <ViewTitle
                title={<Trans>Browse MCP servers</Trans>}
                onBack={() => setView("browse")}
              />
              <IntegrationSetup
                botId={activeBotId}
                initialQuery={publicCatalogQuery || undefined}
                onDone={() => {
                  setView("manage");
                  void refresh().catch((err: unknown) =>
                    setCatalogError(errorText(err, t`Could not load integrations`)),
                  );
                }}
              />
            </div>
          ) : (
            <PluginBrowse
              browse={browse}
              state={state}
              tileContext={tileContext}
              onOpenPlugin={openPlugin}
              onSearchPublic={(publicQuery) => {
                setPublicCatalogQuery(publicQuery);
                openAddView("browseMcp");
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
