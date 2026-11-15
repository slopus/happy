import { Plural, Trans } from "@lingui/react/macro";
import type { CapabilityInstall, ConnectionCatalogItem, McpServer } from "@rakazo/contracts";
import { mcpServerNeedsSignIn } from "@rakazo/contracts";
import { catalogItemKey } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import type { PluginSelection } from "../../components/integrations/plugin-marketplace";
import {
  PluginLogo,
  ROW_BUTTON,
  ROW_HOVER,
  ROW_SHELL,
} from "../../components/integrations/plugin-marketplace";
import {
  AvailabilityControl,
  AvailabilityLabel,
} from "../../components/integrations/space-availability";
import type { TileContext } from "./parts";
import { CatalogTile, ConnectionStatus, ConnectorIcon, ViewTitle } from "./parts";
import type { PluginConnections } from "./use-plugin-connections";

/** "Your apps": connected apps, installed plugins, MCP servers, and custom tool sources. */
export function ManageView({
  state,
  tileContext,
  connectedItems,
  connectorInstalls,
  standaloneServers,
  appCount,
  sourceError,
  confirmingSource,
  onRemoveSource,
  onOpenMcp,
  installedSelection,
  pluginServers,
  onOpenPlugin,
  onBack,
}: {
  state: PluginConnections;
  tileContext: TileContext;
  connectedItems: ConnectionCatalogItem[];
  connectorInstalls: CapabilityInstall[];
  standaloneServers: McpServer[];
  appCount: number;
  sourceError: string | null;
  /** The source whose removal asks again because it reaches other spaces. */
  confirmingSource: string | null;
  onRemoveSource: (install: CapabilityInstall) => void;
  onOpenMcp?: () => void;
  installedSelection: (install: CapabilityInstall) => PluginSelection;
  pluginServers: (install: CapabilityInstall | undefined) => McpServer[];
  onOpenPlugin: (selection: PluginSelection) => void;
  onBack: () => void;
}) {
  const { mcpError, mcpQuery, sources, pending, refresh } = state;
  const appPlugins = connectorInstalls;
  const hasApps = appCount > 0 || Boolean(mcpError);
  return (
    <div data-testid="integrations-manage" className="space-y-8">
      <ViewTitle title={<Trans>Your apps</Trans>} onBack={onBack} />

      {hasApps ? (
        <section data-testid="connected-apps">
          {onOpenMcp && standaloneServers.length ? (
            <div className="mb-2 flex justify-end">
              <Button variant="link" size="xs" onClick={onOpenMcp}>
                <Trans>Manage MCP servers</Trans>
              </Button>
            </div>
          ) : null}
          {mcpError ? (
            <div
              role="alert"
              className="mb-2 flex items-center gap-2 px-2.5 text-body text-destructive"
            >
              {mcpError}
              <Button variant="link" size="xs" onClick={() => void mcpQuery.refetch()}>
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          {sourceError ? (
            <p role="alert" className="mb-2 px-2.5 text-body text-destructive">
              {sourceError}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {connectedItems.map((item) => (
              <CatalogTile
                key={catalogItemKey(item)}
                item={item}
                label={item.name}
                logo={item.logo}
                tileTestId={false}
                context={tileContext}
              />
            ))}
            {appPlugins.map((install) => (
              <InstalledPluginRow
                key={`${install.id}:connector`}
                install={install}
                selection={installedSelection(install)}
                servers={pluginServers(install)}
                onOpen={onOpenPlugin}
              />
            ))}
            <div data-testid="registered-mcp-servers" className="contents">
              {standaloneServers.map((server) => (
                <div
                  key={server.id}
                  data-testid="registered-mcp-server"
                  className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
                >
                  <ConnectorIcon name={server.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{server.name}</span>
                    <ConnectionStatus server={server} />
                  </span>
                  <AvailabilityLabel availability={server.availability} />
                </div>
              ))}
            </div>
            <div data-testid="tool-sources" className="contents">
              {sources.map((source) => (
                <div
                  key={source.id}
                  data-testid="tool-source"
                  className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
                >
                  <ConnectorIcon name={source.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-lg font-medium">{source.name}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {source.kind === "api"
                        ? "OpenAPI"
                        : source.kind === "graphql"
                          ? "GraphQL"
                          : "MCP"}{" "}
                      {source.source}
                    </span>
                    <span className="mt-1 block">
                      <AvailabilityControl
                        kind="install"
                        id={source.id}
                        availability={source.availability}
                        onChanged={refresh}
                      />
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant={confirmingSource === source.id ? "destructive" : "secondary"}
                    size="sm"
                    disabled={pending === source.id}
                    onClick={() => onRemoveSource(source)}
                  >
                    {pending === source.id ? (
                      <Trans>Removing…</Trans>
                    ) : confirmingSource === source.id ? (
                      <Trans>Remove from every space?</Trans>
                    ) : (
                      <Trans>Remove</Trans>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InstalledPluginRow({
  install,
  selection,
  servers,
  onOpen,
}: {
  install: CapabilityInstall;
  selection: PluginSelection;
  servers: McpServer[];
  onOpen: (selection: PluginSelection) => void;
}) {
  const signInNeeded = servers.some(mcpServerNeedsSignIn);
  return (
    <div data-testid="installed-plugin" className={`${ROW_SHELL} ${ROW_HOVER}`}>
      <button type="button" className={ROW_BUTTON} onClick={() => onOpen(selection)}>
        <PluginLogo name={selection.name} logo={selection.logo} site={selection.site} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium">{selection.name}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            <Plural value={servers.length} one="# connector" other="# connectors" />
          </span>
        </span>
      </button>
      <AvailabilityLabel availability={install.availability} />
      {signInNeeded ? (
        <Button variant="secondary" size="sm" onClick={() => onOpen(selection)}>
          <Trans>Sign in</Trans>
        </Button>
      ) : null}
    </div>
  );
}
