import { useLingui } from "@lingui/react/macro";
import type {
  CapabilityInstall,
  Connection,
  ConnectionCatalogItem,
  McpSourcePreset,
} from "@rakazo/contracts";
import {
  catalogItemAccounts,
  catalogItemKey,
  connectCatalogItem,
  isCatalogItemConnected,
} from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { connectedAppMarks } from "../../lib/connected-apps";
import { optionalCatalogFeedProbe } from "../../lib/optional-catalog-feed";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const NO_CATALOG: ConnectionCatalogItem[] = [];
const NO_CONNECTIONS: Connection[] = [];
const NO_SOURCES: CapabilityInstall[] = [];
const NO_PRESETS: McpSourcePreset[] = [];

function markConnected(
  items: ConnectionCatalogItem[],
  connectorId: string,
  slug: string,
  connected: boolean,
) {
  return items.map((entry) =>
    entry.connectorId === connectorId && entry.slug === slug ? { ...entry, connected } : entry,
  );
}

export type PluginConnections = ReturnType<typeof usePluginConnections>;

/**
 * The integrations the overlay lists (apps, accounts, MCP servers, tool sources, plugins) and the
 * actions that connect, rename, revoke, and uninstall them. Every view reads the same state.
 */
export function usePluginConnections({
  activeBotId,
  detailKey,
  closeDetail,
  onConnectedAppsChange,
}: {
  activeBotId?: string;
  /** The app whose page is open; its tools load while it is. */
  detailKey: { connectorId: string; slug: string } | null;
  closeDetail: () => void;
  onConnectedAppsChange?: (apps: ReturnType<typeof connectedAppMarks>) => void;
}) {
  const { t } = useLingui();
  // Only accounts whose label is being edited; the rest follow the saved name.
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const mcpOptions = queries.mcp.servers.list.queryOptions();
  const mcpQuery = useQuery(mcpOptions);
  const mcpServers = mcpQuery.data ?? [];
  const sourcePresets =
    useQuery(queries.capabilities.sourcePresets.queryOptions()).data ?? NO_PRESETS;
  const mcpError = mcpQuery.error ? errorText(mcpQuery.error, t`Could not load MCP servers`) : null;
  async function loadIntegrations() {
    // The catalog call reconciles connection rows, so list them after it settles.
    const catalog = rpc.connections.catalog({});
    const [items, installs, rows, catalogFeed] = await Promise.all([
      catalog,
      rpc.capabilities.list(),
      catalog.catch(() => undefined).then(() => rpc.connections.list()),
      optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
    ]);
    return {
      catalog: items,
      connections: rows,
      sources: installs.filter(
        (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
      ),
      plugins: installs.filter((install) => install.kind === "plugin"),
      catalogFeedEnabled: catalogFeed.enabled,
    };
  }
  const integrationsOptions = queryOptions({
    queryKey: [...queries.connections.catalog.queryKey({ input: {} }), "integrations"],
    queryFn: loadIntegrations,
  });
  const integrations = useQuery(integrationsOptions);
  const catalogLoaded = integrations.data !== undefined;
  const loading = !catalogLoaded && integrations.isFetching;
  const catalog = integrations.data?.catalog ?? NO_CATALOG;
  const connections = integrations.data?.connections ?? NO_CONNECTIONS;
  const sources = integrations.data?.sources ?? NO_SOURCES;
  const pluginInstalls = integrations.data?.plugins ?? NO_SOURCES;
  const pluginCatalog = useQuery(
    queries.marketplace.catalog.queryOptions({ input: { query: "" }, staleTime: 60_000 }),
  );
  const assignmentsQuery = useQuery(
    queries.mcp.assignments.list.queryOptions({
      input: activeBotId ? { botId: activeBotId } : skipToken,
    }),
  );
  const assigned = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((row) => row.serverId)),
    [assignmentsQuery.data],
  );
  const catalogFeedEnabled = integrations.data?.catalogFeedEnabled ?? false;
  // A failed refresh is shown even over what was cached, so stale apps never pass as current.
  const loadError = integrations.error
    ? errorText(integrations.error, t`Could not load integrations`)
    : null;
  const toolsQuery = useQuery(
    queries.connections.tools.queryOptions({
      input: detailKey
        ? { connectorId: detailKey.connectorId, provider: detailKey.slug }
        : skipToken,
    }),
  );
  const tools = (detailKey && toolsQuery.data) || [];
  const toolsLoading = detailKey !== null && toolsQuery.isPending && toolsQuery.isFetching;

  function updateIntegrations(
    update: (
      current: NonNullable<typeof integrations.data>,
    ) => NonNullable<typeof integrations.data>,
  ) {
    return writeSaved(queryClient, integrationsOptions.queryKey, (current) =>
      update(
        current ?? {
          catalog: NO_CATALOG,
          connections: NO_CONNECTIONS,
          sources: NO_SOURCES,
          plugins: NO_SOURCES,
          catalogFeedEnabled: false,
        },
      ),
    );
  }

  /** Reads integrations again with requests sent after a change. */
  async function refresh() {
    void fetchFresh(queryClient, mcpOptions).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: queries.mcp.assignments.key() });
    await fetchFresh(queryClient, {
      queryKey: integrationsOptions.queryKey,
      queryFn: loadIntegrations,
    });
  }

  function refreshTools() {
    void queryClient.invalidateQueries({
      queryKey: queries.connections.tools.key(),
    });
  }

  useEffect(() => {
    return () => connectionAttempt.current?.abort();
  }, []);

  useEffect(() => {
    if (catalogLoaded) onConnectedAppsChange?.(connectedAppMarks(catalog, connections));
  }, [catalog, catalogLoaded, connections, onConnectedAppsChange]);

  function itemConnected(item: ConnectionCatalogItem) {
    return isCatalogItemConnected(connections, item);
  }

  async function notifyAppConnected(item: ConnectionCatalogItem) {
    if (!activeBotId) return;
    await rpc.onboarding
      .appConnected({
        botId: activeBotId,
        provider: item.slug,
        connectorId: item.connectorId,
      })
      .catch(() => undefined);
  }

  function setItemConnected(item: ConnectionCatalogItem, connected: boolean) {
    return updateIntegrations((current) => ({
      ...current,
      catalog: markConnected(current.catalog, item.connectorId, item.slug, connected),
    }));
  }

  async function connect(item: ConnectionCatalogItem) {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setCatalogError(null);
    const key = catalogItemKey(item);
    setPending(key);
    try {
      const result = await connectCatalogItem(item, connections, {
        begin: (input) => rpc.connections.begin(input),
        complete: (input) => rpc.connections.complete(input),
        openUrl: (url) => window.open(url, "rakazo-plugin-connect", "noopener,noreferrer"),
        signal: controller.signal,
      });
      if (result.status === "aborted") return;
      if (result.status === "connected") {
        await setItemConnected(item, true);
        void notifyAppConnected(item);
        await refresh().catch(() => undefined);
        refreshTools();
        return;
      }
      setCatalogError(
        t`Connection to ${item.name} is still pending. You can close this and check again.`,
      );
      await refresh().catch(() => undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      setCatalogError(errorText(err, t`Could not connect`));
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setPending(null);
      }
    }
  }

  async function revokeAccount(row: Connection, item: ConnectionCatalogItem) {
    setCatalogError(null);
    setPending(row.id);
    try {
      await rpc.connections.revoke({ connectionId: row.id });
      const remaining = catalogItemAccounts(connections, item).filter(
        (entry) => entry.id !== row.id,
      );
      if (remaining.every((entry) => entry.status !== "connected")) {
        await setItemConnected(item, false);
      }
      await refresh().catch(() => undefined);
      refreshTools();
    } catch (err) {
      setCatalogError(errorText(err, t`Could not revoke connection`));
    } finally {
      setPending(null);
    }
  }

  async function uninstall(item: ConnectionCatalogItem) {
    const matches = catalogItemAccounts(connections, item);
    if (matches.length === 0) {
      void setItemConnected(item, false);
      closeDetail();
      return;
    }
    setCatalogError(null);
    setPending(`uninstall:${catalogItemKey(item)}`);
    try {
      for (const row of matches) {
        await rpc.connections.revoke({ connectionId: row.id });
      }
      await setItemConnected(item, false);
      await refresh().catch(() => undefined);
      closeDetail();
    } catch (err) {
      setCatalogError(errorText(err, t`Could not revoke connection`));
      await refresh().catch(() => undefined);
    } finally {
      setPending(null);
    }
  }

  async function renameAccount(row: Connection) {
    const displayName = (labelDrafts[row.id] ?? row.displayName).trim();
    const clearDraft = () => setLabelDrafts(({ [row.id]: _draft, ...rest }) => rest);
    if (!displayName || displayName === row.displayName) {
      clearDraft();
      return;
    }
    setPending(`rename:${row.id}`);
    setCatalogError(null);
    try {
      const updated = await rpc.connections.rename({
        connectionId: row.id,
        displayName,
      });
      await updateIntegrations((current) => ({
        ...current,
        connections: current.connections.map((entry) =>
          entry.id === row.id ? { ...entry, displayName: updated.displayName } : entry,
        ),
      }));
      clearDraft();
    } catch (err) {
      setCatalogError(errorText(err, t`Could not rename connection`));
    } finally {
      setPending(null);
    }
  }

  return {
    mcpQuery,
    mcpServers,
    sourcePresets,
    mcpError,
    integrations,
    catalogLoaded,
    loading,
    catalog,
    connections,
    sources,
    pluginInstalls,
    pluginCatalog,
    assigned,
    catalogFeedEnabled,
    loadError,
    tools,
    toolsLoading,
    updateIntegrations,
    refresh,
    labelDrafts,
    setLabelDrafts,
    pending,
    setPending,
    catalogError,
    setCatalogError,
    itemConnected,
    connect,
    revokeAccount,
    uninstall,
    renameAccount,
  };
}
