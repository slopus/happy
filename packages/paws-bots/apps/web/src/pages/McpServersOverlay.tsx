import { t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BotMcpServer, McpServer } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorNotice } from "../components/ErrorNotice";
import type { AgentAccess } from "../components/integrations/agent-access";
import { AgentAccessControl } from "../components/integrations/agent-access";
import {
  AvailabilityControl,
  reachesOtherSpaces,
  useOwnSpaces,
} from "../components/integrations/space-availability";
import { McpServerHealthLine } from "../components/McpServerHealthLine";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "../lib/mcp-connect";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import type { ErrorDetails } from "../lib/user-error";
import { errorCode, errorDetails } from "../lib/user-error";
import {
  duplicateEnvNames,
  emptyMcpServerDraft,
  McpServerForm,
  mcpServerConfig,
  mcpServerDraftFor,
} from "./McpServerForm";

/** How often the list is re-read while a server installs its package or is being tested. */
const INSTALL_POLL_MS = 2500;

/** A server whose authorization server cannot register a client until the user enters one. */
function needsOAuthClient(server: McpServer): boolean {
  return server.health.code === MCP_OAUTH_CLIENT_REQUIRED && !server.oauthClientId;
}

function sameAccess(a: AgentAccess, b: AgentAccess): boolean {
  return a.allBots === b.allBots && [...a.botIds].sort().join() === [...b.botIds].sort().join();
}

function oauthActionLabel(server: McpServer, pending: boolean): string {
  if (pending) return t`Connecting…`;
  return server.oauthStatus === "none" ? t`Connect OAuth` : t`Reconnect OAuth`;
}

export function McpServersOverlay({
  onClose,
  editServerId,
  stdioEnabled,
}: {
  onClose: () => void;
  /** Opens with this server's form, as an import's setup checklist does. */
  editServerId?: string;
  /** Whether this deployment runs stdio servers. */
  stdioEnabled: boolean;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [draft, setDraft] = useState(() => emptyMcpServerDraft("streamable_http"));
  const [focusOAuthClient, setFocusOAuthClient] = useState(false);
  const oauthClientIdInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ErrorDetails | null>(null);
  const [saving, setSaving] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set());
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const serversOptions = queries.mcp.servers.list.queryOptions();
  const serversQuery = useQuery({
    ...serversOptions,
    // A freshly saved stdio server installs its package in the background, so its health
    // moves installing -> ok/error on its own, and a test can spend minutes installing.
    // Re-read the list while either is true so the card follows along; a refused request
    // stops it.
    refetchInterval: (query) => {
      const error = query.state.error;
      if (error && !isRetryableError(error)) return false;
      const installing = query.state.data?.some((server) => server.health.status === "installing");
      return testingIds.size > 0 || installing ? INSTALL_POLL_MS : false;
    },
  });
  const botsOptions = queries.bots.list.queryOptions();
  const botsQuery = useQuery(botsOptions);
  const assignmentsOptions = queries.mcp.assignments.all.queryOptions();
  const assignmentsQuery = useQuery(assignmentsOptions);
  const servers = serversQuery.data ?? [];
  const spaceCount = useOwnSpaces().length;
  const bots = useMemo(
    () => (botsQuery.data ?? []).filter((bot) => !bot.archivedAt),
    [botsQuery.data],
  );
  const botAssignments = useMemo(() => {
    const assignments = assignmentsQuery.data ?? [];
    return Object.fromEntries(
      bots.map((bot) => [bot.id, assignments.filter((assignment) => assignment.botId === bot.id)]),
    ) as Record<string, BotMcpServer[]>;
  }, [bots, assignmentsQuery.data]);
  // replace() overwrites a bot's whole list, so changes wait for a read of every assignment.
  const assignmentsReady = assignmentsQuery.isSuccess && !assignmentsQuery.isFetching;
  const loadFailed = serversQuery.isError || botsQuery.isError || assignmentsQuery.isError;
  const shownError = error ?? (loadFailed ? errorDetails(t`Could not load MCP servers`) : null);

  /** Reads everything again with requests sent after a change. */
  async function refresh() {
    await Promise.all([
      fetchFresh(queryClient, serversOptions),
      fetchFresh(queryClient, botsOptions),
      fetchFresh(queryClient, assignmentsOptions),
    ]);
  }

  const openedEditServer = useRef(false);
  useEffect(() => {
    if (!editServerId || openedEditServer.current) return;
    const server = servers.find((item) => item.id === editServerId);
    if (!server) return;
    openedEditServer.current = true;
    startEditing(server);
  }, [editServerId, servers]);

  useEffect(() => {
    // BroadcastChannel instead of window.opener messaging: provider login
    // pages with COOP sever the opener link, but the channel is origin-scoped
    // and unaffected.
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      setOauthPending(null);
      void refresh().catch(() => undefined);
    };
    return () => channel.close();
  }, [queries]);

  function resetForm() {
    setEditing(null);
    setAdding(false);
    setDraft((current) =>
      emptyMcpServerDraft(stdioEnabled ? current.transport : "streamable_http"),
    );
  }

  function startEditing(server: McpServer, showOAuthClient = needsOAuthClient(server)) {
    resetForm();
    setError(null);
    setEditing(server);
    setDraft(mcpServerDraftFor(server, accessOf(server), showOAuthClient));
    if (showOAuthClient) setFocusOAuthClient(true);
  }

  useEffect(() => {
    if (!focusOAuthClient || !draft.advancedOpen) return;
    oauthClientIdInput.current?.focus();
    setFocusOAuthClient(false);
  }, [focusOAuthClient, draft.advancedOpen]);

  async function saveServer() {
    if (draft.transport === "stdio" && duplicateEnvNames(draft.envRows).size > 0) return;
    setError(null);
    if (!draft.name.trim()) {
      setError(errorDetails(t`Add a server name.`));
      return;
    }
    if (draft.transport !== "stdio" && !draft.endpoint.trim()) {
      setError(errorDetails(t`Add an HTTPS server URL.`));
      return;
    }
    if (draft.transport === "stdio" && !draft.command.trim()) {
      setError(errorDetails(t`Add a stdio command.`));
      return;
    }
    setSaving(true);
    try {
      const config = mcpServerConfig(draft, editing);
      if (editing) {
        await rpc.mcp.servers.update({
          id: editing.id,
          config: {
            ...config,
            slug: editing.slug,
            description: editing.description,
            enabled: editing.enabled,
          },
        });
        if (!sameAccess(draft.access, accessOf(editing)))
          await rpc.mcp.servers.agents({ id: editing.id, ...draft.access });
        await refresh();
        resetForm();
        return;
      }
      const created = await rpc.mcp.servers.create(config);
      if (!draft.access.allBots) await rpc.mcp.servers.agents({ id: created.id, ...draft.access });
      await refresh();
      resetForm();
      // A remote server is checked in the background; wait for that check so a server
      // that cannot work as entered says so now. It starts after the refresh, whose read
      // the test's cache write would otherwise cancel.
      if (created.health.status === "unknown" && !created.health.checkedAt)
        void testServer(created, false);
    } catch (err) {
      setError(errorDetails(err, editing ? t`Could not save` : t`Could not add MCP server`));
    } finally {
      setSaving(false);
    }
  }

  async function connectOAuth(server: McpServer) {
    setError(null);
    setOauthPending(server.id);
    try {
      const result = await connectMcpOauth(server.id);
      if (result !== "cancelled") setOauthPending(null);
      await refresh();
      if (result === "connected") return;
      if (result === "already_connected") {
        setError(
          errorDetails(
            t`This server is already connected. Disconnect it first to authorize again.`,
          ),
        );
        return;
      }
      if (result === "authorization_not_requested") {
        setError(errorDetails(t`This server did not request browser authorization.`));
        return;
      }
      setOauthPending((current) => (current === server.id ? null : current));
    } catch (err) {
      setOauthPending(null);
      if (errorCode(err) === MCP_OAUTH_CLIENT_REQUIRED) {
        startEditing(server, true);
        void refresh().catch(() => undefined);
      }
      setError(errorDetails(err, t`Could not start OAuth`));
    }
  }

  async function setServerAgents(server: McpServer, access: AgentAccess) {
    if (!assignmentsReady) return;
    setError(null);
    try {
      const updated = await rpc.mcp.servers.agents({ id: server.id, ...access });
      await Promise.all([
        writeSaved(queryClient, serversOptions.queryKey, (current) =>
          (current ?? []).map((item) => (item.id === server.id ? updated.server : item)),
        ),
        writeSaved(queryClient, assignmentsOptions.queryKey, (all) => [
          ...(all ?? []).filter((entry) => entry.serverId !== server.id),
          ...updated.assignments,
        ]),
      ]);
    } catch (err) {
      setError(errorDetails(err, t`Could not update bot access`));
    }
  }

  function accessOf(server: McpServer): AgentAccess {
    return {
      allBots: server.allBots ?? false,
      botIds: bots
        .filter((bot) =>
          (botAssignments[bot.id] ?? []).some((entry) => entry.serverId === server.id),
        )
        .map((bot) => bot.id),
    };
  }

  async function deleteServer(server: McpServer) {
    setDeleting(null);
    setError(null);
    try {
      await rpc.mcp.servers.remove({ id: server.id });
      if (editing?.id === server.id) resetForm();
      await refresh();
    } catch (err) {
      setError(errorDetails(err, t`Could not delete MCP server`));
    }
  }

  async function testServer(server: McpServer, announce = true) {
    setError(null);
    setTestingIds((current) => new Set(current).add(server.id));
    try {
      const updated = await rpc.mcp.servers.test({ id: server.id });
      await writeSaved(queryClient, serversOptions.queryKey, (current) =>
        (current ?? []).map((item) => (item.id === updated.id ? updated : item)),
      );
      if (!announce) return;
      if (updated.health.status === "ok") {
        toast.success(t`${updated.name} is running`);
      } else if (updated.health.status === "error") {
        toast.error(t`${updated.name} is not working`);
      }
    } catch (err) {
      setError(errorDetails(err, t`Could not test MCP server`));
    } finally {
      setTestingIds((current) => {
        const next = new Set(current);
        next.delete(server.id);
        return next;
      });
    }
  }

  async function disconnectOAuth(server: McpServer) {
    setError(null);
    try {
      setOauthPending(server.id);
      await rpc.mcp.oauth.disconnect({ serverId: server.id });
      await refresh();
    } catch (err) {
      setError(errorDetails(err, t`Could not disconnect OAuth`));
    } finally {
      setOauthPending(null);
    }
  }

  // A save refreshes the list before it resets the form, so the form waits for the reset.
  const formOpen =
    saving || adding || editing !== null || (serversQuery.isSuccess && servers.length === 0);

  function renderServer(server: McpServer) {
    const oauth =
      (server.transport !== "stdio" || server.oauthClientId) && !needsOAuthClient(server);
    // A working server does not need signing in up front, so the action waits in its menu.
    const signInFirst =
      oauth &&
      (server.oauthStatus === "reconnect" ||
        (server.oauthStatus === "none" && server.health.status !== "ok"));
    const pending = oauthPending === server.id;
    const testing = testingIds.has(server.id);
    const working = server.health.status === "ok" && !testing;
    return (
      <li
        key={server.id}
        data-testid="mcp-server"
        className="flex items-start justify-between gap-3 py-3"
      >
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-body font-medium text-foreground">{server.name}</span>
            {working && server.health.toolCount !== null ? (
              <span className="shrink-0 text-label text-muted-foreground">
                <Plural value={server.health.toolCount} one="# tool" other="# tools" />
              </span>
            ) : null}
          </div>
          <p className="truncate text-label text-muted-foreground">
            {server.endpoint ?? server.command ?? server.slug}
          </p>
          <McpServerHealthLine health={server.health} checking={testing} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {server.installId ? null : (
            <AvailabilityControl
              kind="mcpServer"
              id={server.id}
              availability={server.availability}
              onChanged={() => serversQuery.refetch()}
            />
          )}
          <AgentAccessControl
            bots={bots}
            access={accessOf(server)}
            disabled={!assignmentsReady}
            onChange={(access) => void setServerAgents(server, access)}
          />
          {signInFirst ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void connectOAuth(server)}
            >
              {oauthActionLabel(server, pending)}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={t`Actions for ${server.name}`} />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => startEditing(server)}>
                <Trans>Edit</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={testing || server.health.status === "installing"}
                onClick={() => void testServer(server)}
              >
                <Trans>Test connection</Trans>
              </DropdownMenuItem>
              {oauth && !signInFirst ? (
                <DropdownMenuItem disabled={pending} onClick={() => void connectOAuth(server)}>
                  {oauthActionLabel(server, pending)}
                </DropdownMenuItem>
              ) : null}
              {oauth && server.oauthStatus !== "none" ? (
                <DropdownMenuItem disabled={pending} onClick={() => void disconnectOAuth(server)}>
                  <Trans>Disconnect</Trans>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(server)}>
                <Trans>Delete</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="md">
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border px-6 py-5">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>MCP servers</Trans>
          </DialogTitle>
          <div className="flex items-center gap-1">
            {formOpen ? null : (
              <Button type="button" size="sm" onClick={() => setAdding(true)}>
                <Plus />
                <Trans>Add server</Trans>
              </Button>
            )}
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close MCP servers`} />}
            >
              <X />
            </DialogClose>
          </div>
        </DialogHeader>
        {shownError ? (
          <div className="mx-6 mt-5 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
            <ErrorNotice error={shownError} />
          </div>
        ) : null}
        <div className="rk-scroll min-h-0 overflow-y-auto px-6 py-5">
          {formOpen ? (
            <McpServerForm
              draft={draft}
              setDraft={setDraft}
              editing={editing}
              canGoBack={servers.length > 0}
              saving={saving}
              stdioEnabled={stdioEnabled}
              bots={bots}
              assignmentsReady={assignmentsReady}
              oauthClientIdInput={oauthClientIdInput}
              onBack={resetForm}
              onSave={() => void saveServer()}
            />
          ) : (
            <ul className="-my-3 divide-y divide-border">{servers.map(renderServer)}</ul>
          )}
        </div>
        {deleting ? (
          <ConfirmDialog
            onCancel={() => setDeleting(null)}
            title={
              reachesOtherSpaces(deleting.availability, spaceCount) ? (
                <Trans>Remove from every space?</Trans>
              ) : (
                t`Delete ${deleting.name}?`
              )
            }
            onConfirm={() => void deleteServer(deleting)}
            confirmLabel={<Trans>Delete</Trans>}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
