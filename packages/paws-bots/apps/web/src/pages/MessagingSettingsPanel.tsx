import { listenWindow } from "../paws/runtime";
import { hostNavigate } from "../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessagingChannelMembership, MessagingInstallationsStatus } from "@rakazo/contracts";
import { isRetryableError, messagingConnectOptions } from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { providerLabel } from "../lib/messaging";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { ExternalConversationSettings } from "./ExternalConversationSettings";

const LINK_POLL_MS = 3_000;
const NO_INSTALLATIONS: MessagingInstallationsStatus = { available: false, installations: [] };

function Row({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 text-body text-foreground/75">
      <span className="min-w-0 truncate">{children}</span>
      <span className="flex shrink-0 gap-2">{actions}</span>
    </li>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="ml-2 text-label text-muted-foreground/70">{children}</span>;
}

export function MessagingSettingsPanel() {
  const { t } = useLingui();
  const [settingsConversationId, setSettingsConversationId] = useState<string | null>(null);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [linkRequest, setLinkRequest] = useState<{
    code: string;
    expiresAt: string;
    shared?: boolean;
    botId: string;
    provider: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusOptions = queries.messaging.status.queryOptions();
  const channelsOptions = queries.messaging.channels.list.queryOptions();
  const connectionsOptions = queries.messaging.connections.list.queryOptions();
  const botsOptions = queries.bots.list.queryOptions();
  const spacesOptions = queries.spaces.list.queryOptions();
  const installationsOptions = queries.messaging.installations.list.queryOptions();
  const statusQuery = useQuery(statusOptions);
  const channelsQuery = useQuery(channelsOptions);
  const connectionsQuery = useQuery(connectionsOptions);
  const botsQuery = useQuery(botsOptions);
  const spacesQuery = useQuery(spacesOptions);
  const installationsQuery = useQuery(installationsOptions);
  const status = statusQuery.data ?? null;
  const channels = channelsQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const bots = botsQuery.data ?? [];
  const externalConversations = spacesQuery.data?.current.externalConversations ?? [];
  const installationStatus = installationsQuery.data ?? NO_INSTALLATIONS;
  // A failed refresh is shown even over cached settings.
  const loadFailed = [
    statusQuery,
    channelsQuery,
    connectionsQuery,
    botsQuery,
    spacesQuery,
    installationsQuery,
  ].some((query) => query.isError);
  const shownError = error ?? (loadFailed ? t`Couldn't load messaging settings` : null);

  /** Reads everything again with requests sent after a change. */
  async function refresh() {
    await Promise.all([
      fetchFresh(queryClient, statusOptions),
      fetchFresh(queryClient, channelsOptions),
      fetchFresh(queryClient, connectionsOptions),
      fetchFresh(queryClient, botsOptions),
      fetchFresh(queryClient, spacesOptions),
      fetchFresh(queryClient, installationsOptions),
    ]);
  }

  // Linking completes in the chat app: watch for a new or reassigned identity.
  useEffect(() => {
    if (!linkRequest) return;
    const known = new Map(status?.identities.map((identity) => [identity.id, identity.botId]));
    let active = true;
    let poll: number;
    const expire = window.setTimeout(
      () => {
        active = false;
        window.clearTimeout(poll);
        setLinkRequest(null);
      },
      Math.max(0, Date.parse(linkRequest.expiresAt) - Date.now()),
    );
    async function pollStatus() {
      try {
        const next = await rpc.messaging.status();
        if (!active) return;
        if (
          next.identities.some(
            (identity) =>
              identity.provider === linkRequest?.provider &&
              identity.botId === linkRequest?.botId &&
              known.get(identity.id) !== identity.botId,
          )
        ) {
          active = false;
          window.clearTimeout(expire);
          await writeSaved(queryClient, statusOptions.queryKey, () => next);
          setLinkRequest(null);
          await refresh();
        }
      } catch (error) {
        // A transient failure can be retried while the code is valid.
        if (!isRetryableError(error)) active = false;
      } finally {
        if (active) poll = window.setTimeout(() => void pollStatus(), LINK_POLL_MS);
      }
    }
    poll = window.setTimeout(() => void pollStatus(), LINK_POLL_MS);
    return () => {
      active = false;
      window.clearTimeout(poll);
      window.clearTimeout(expire);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkRequest]);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    // A displayed code must always match the current selection and link
    // state; the link action re-sets it after issuing.
    setLinkRequest(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Couldn't update messaging settings`);
    }
  }

  useEffect(() => {
    // A failed read shows through the queries' error.
    const onFocus = () => void refresh().catch(() => undefined);
    listenWindow("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // A selection archived elsewhere drops out of the list; fall back to the first bot.
  const linkBotId = bots.find((bot) => bot.id === selectedBotId)?.id ?? bots[0]?.id ?? "";
  const botName = (botId: string) => bots.find((bot) => bot.id === botId)?.name;
  // Only meaningful once a second chat app is linked: the same group can then
  // hold two of the caller's memberships, one per agent.
  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  function channelMeta(channel: MessagingChannelMembership): string {
    return [
      providerLabel(channel.provider),
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  }

  const connectOptions = messagingConnectOptions(
    (status?.providers ?? []).filter(
      (provider) => provider !== "slack" || installationsQuery.isSuccess,
    ),
    installationsQuery.isSuccess && installationStatus.available,
  );
  const slackInstall = connectOptions.some(({ method }) => method === "install");
  const linkOptions = connectOptions.filter(({ method }) => method === "link");
  const slackInstallations = installationStatus.installations.filter(
    (installation) => installation.provider === "slack",
  );
  // A teammate's workspace: DMs link to a bot of the member's own choosing.
  const memberLink =
    Boolean(installationStatus.personalLinkAvailable) &&
    Boolean(status?.providers.includes("slack"));
  const invitedChannels = channels.filter((channel) => channel.status === "invited");
  const incomingConnections = connections.filter(
    (connection) => connection.status === "pending" && connection.incoming,
  );
  const joinedChannels = channels.filter((channel) => channel.status === "approved");
  const otherConnections = connections.filter(
    (connection) =>
      connection.status === "approved" || (connection.status === "pending" && !connection.incoming),
  );
  const hasRequests = invitedChannels.length > 0 || incomingConnections.length > 0;
  const hasConversations =
    joinedChannels.length > 0 || otherConnections.length > 0 || externalConversations.length > 0;

  const linkCode = linkRequest?.code;
  const linkApp = linkRequest ? providerLabel(linkRequest.provider) : "";
  const linkAddress = linkRequest ? status?.addresses?.[linkRequest.provider] : undefined;

  function startLink(provider: string, botId: string) {
    void act(async () => {
      const issued = await rpc.messaging.link.start({ botId });
      setLinkRequest({ ...issued, botId, provider });
    });
  }

  function installSlack() {
    const popup = window.open("about:blank", "rakazo-slack-install");
    if (popup) popup.opener = null;
    void act(async () => {
      try {
        const { url } = await rpc.messaging.installations.start({});
        if (popup) popup.location.href = url;
        else hostNavigate(url);
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }

  const botPicker =
    bots.length > 1 ? (
      <NativeSelect
        aria-label={t`Bot`}
        value={linkBotId}
        onChange={(event) => {
          setSelectedBotId(event.target.value);
          setLinkRequest(null);
        }}
      >
        {bots.map((bot) => (
          <NativeSelectOption key={bot.id} value={bot.id}>
            {bot.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : null;

  const memberLinkControls = (
    <>
      {botPicker}
      <Button
        size="sm"
        variant="ghost"
        disabled={!linkBotId}
        onClick={() => startLink("slack", linkBotId)}
      >
        <Trans>Link DMs</Trans>
      </Button>
    </>
  );

  const respondButtons = (respond: (accept: boolean) => Promise<unknown>) => (
    <>
      <Button size="sm" onClick={() => void act(() => respond(true))}>
        <Trans>Approve</Trans>
      </Button>
      <Button size="sm" variant="secondary" onClick={() => void act(() => respond(false))}>
        <Trans>Decline</Trans>
      </Button>
    </>
  );

  return (
    <div data-testid="messaging-settings" className="space-y-8">
      {shownError ? <p className="text-body-sm text-destructive">{shownError}</p> : null}

      {hasRequests ? (
        <section>
          <SectionHeading variant="label">
            <Trans>Requests</Trans>
          </SectionHeading>
          <ul className="mt-3 space-y-3">
            {invitedChannels.map((channel) => (
              <Row
                key={channel.id}
                actions={respondButtons((accept) =>
                  rpc.messaging.channels.respond({ membershipId: channel.id, accept }),
                )}
              >
                {channel.name ?? t`Group`}
                <Meta>{channelMeta(channel)}</Meta>
              </Row>
            ))}
            {incomingConnections.map((connection) => (
              <Row
                key={connection.id}
                actions={respondButtons((accept) =>
                  rpc.messaging.connections.respond({ connectionId: connection.id, accept }),
                )}
              >
                {connection.peerOwnerLabel}
                {"'s "}
                {connection.peerBotName}
              </Row>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Saved workspaces stay listed even when a refresh fails. */}
      {slackInstall || slackInstallations.length ? (
        <SettingsGroup data-testid="messaging-slack">
          {slackInstallations.length === 0 ? (
            <SettingsRow
              label={
                <>
                  <p>{providerLabel("slack")}</p>
                  <p className="mt-0.5 text-body-sm text-muted-foreground">
                    <Trans>Chat with your bot from Slack.</Trans>
                  </p>
                </>
              }
              control={
                <>
                  {memberLink ? memberLinkControls : null}
                  <Button size="sm" variant="outline" onClick={installSlack}>
                    <Trans>Connect</Trans>
                  </Button>
                </>
              }
            />
          ) : (
            slackInstallations.map((installation) => (
              <SettingsRow
                key={installation.id}
                label={
                  <>
                    <p>{providerLabel("slack")}</p>
                    <p className="mt-0.5 text-body-sm text-muted-foreground">
                      {[
                        installation.workspaceName,
                        installation.botName ?? botName(installation.botId),
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  </>
                }
                control={
                  <>
                    {status?.providers.includes(installation.provider) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startLink(installation.provider, installation.botId)}
                      >
                        <Trans>Link DMs</Trans>
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void act(() => rpc.messaging.installations.remove({ id: installation.id }))
                      }
                    >
                      <Trans>Disconnect</Trans>
                    </Button>
                  </>
                }
              />
            ))
          )}
          {memberLink && slackInstallations.length ? (
            <SettingsRow label={<p>{providerLabel("slack")}</p>} control={memberLinkControls} />
          ) : null}
          {slackInstall && slackInstallations.length ? (
            <button
              type="button"
              onClick={installSlack}
              className="flex w-full items-center gap-2 rounded-b-xl px-4 py-3 text-start text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-4" aria-hidden />
              <Trans>Add workspace</Trans>
            </button>
          ) : null}
        </SettingsGroup>
      ) : null}

      <section>
        {status?.identities.length ? (
          <ul className="mb-4 space-y-3">
            {status.identities.map((identity) => (
              <Row
                key={identity.id}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(() => rpc.messaging.identities.unlink({ identityId: identity.id }))
                    }
                  >
                    <Trans>Unlink</Trans>
                  </Button>
                }
              >
                <span className="text-foreground">{providerLabel(identity.provider)}</span>
                <Meta>
                  {identity.address}, {identity.botName}
                </Meta>
              </Row>
            ))}
          </ul>
        ) : null}
        {linkOptions.length ? (
          <div className="flex flex-wrap items-center gap-2">
            {memberLink ? null : botPicker}
            <DropdownMenu>
              <DropdownMenuTrigger disabled={!linkBotId} render={<Button variant="outline" />}>
                <Trans>Connect a chat app</Trans>
                <ChevronDownIcon data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-44">
                {linkOptions.map(({ provider }) => (
                  <DropdownMenuItem key={provider} onClick={() => startLink(provider, linkBotId)}>
                    {providerLabel(provider)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
        {linkCode ? (
          <p className="mt-3 text-body text-foreground/75" data-testid="messaging-link-code">
            {linkAddress ? (
              <Trans>
                Send <span className="font-mono text-foreground">{linkCode}</span> to{" "}
                <span className="text-foreground">{linkAddress}</span> from {linkApp} within 10
                minutes.
              </Trans>
            ) : (
              <Trans>
                Send <span className="font-mono text-foreground">{linkCode}</span> from {linkApp}{" "}
                within 10 minutes.
              </Trans>
            )}
          </p>
        ) : null}
        {linkCode && linkRequest?.shared ? (
          <p className="mt-1 text-body-sm text-muted-foreground">
            <Trans>Everyone in this bot's space can read the chats it gets from {linkApp}.</Trans>
          </p>
        ) : null}
      </section>

      {hasConversations ? (
        <section>
          <SectionHeading variant="label">
            <Trans>Conversations</Trans>
          </SectionHeading>
          <ul className="mt-3 space-y-3">
            {joinedChannels.map((channel) => (
              <Row
                key={channel.id}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(() => rpc.messaging.channels.leave({ membershipId: channel.id }))
                    }
                  >
                    <Trans>Leave</Trans>
                  </Button>
                }
              >
                {channel.name ?? t`Group`}
                <Meta>{channelMeta(channel)}</Meta>
              </Row>
            ))}
            {otherConnections.map((connection) => (
              <Row
                key={connection.id}
                actions={
                  connection.status === "approved" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void act(() =>
                          rpc.messaging.connections.revoke({ connectionId: connection.id }),
                        )
                      }
                    >
                      <Trans>Revoke</Trans>
                    </Button>
                  ) : (
                    <Meta>
                      <Trans>Pending</Trans>
                    </Meta>
                  )
                }
              >
                {connection.peerOwnerLabel}
                {"'s "}
                {connection.peerBotName}
              </Row>
            ))}
            {externalConversations.map((conversation) => {
              const bot = bots.find((candidate) => candidate.id === conversation.botId);
              const open = settingsConversationId === conversation.id;
              return (
                <li key={conversation.id} className="text-body text-foreground/75">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {conversation.displayName || t`External conversation`}
                      <Meta>{providerLabel(conversation.provider)}</Meta>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSettingsConversationId(open ? null : conversation.id)}
                    >
                      {open ? <Trans>Close</Trans> : <Trans>Settings</Trans>}
                    </Button>
                  </div>
                  {open && bot ? (
                    <div className="mt-4 rounded-lg border border-border px-3 py-3">
                      <ExternalConversationSettings
                        conversation={conversation}
                        bot={bot}
                        onSave={async (policy) => {
                          await rpc.externalConversations.updatePolicy({
                            externalConversationId: conversation.id,
                            ...policy,
                          });
                          await refresh();
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
