import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, McpServer, McpTransport } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import {
  Button,
  Checkbox,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
  Input,
  SectionHeading,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { Disclosure } from "@rakazo/ui-web/components/ui/disclosure";
import { ChevronLeft, X } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AgentAccess } from "../components/integrations/agent-access";
import { AgentAccessControl } from "../components/integrations/agent-access";
import { mcpOAuthRedirectUri } from "../lib/mcp-connect";

type EnvRow = { id: number; name: string; value: string; file: boolean };

/** Everything the add or edit form holds until it is saved. */
export type McpServerDraft = {
  access: AgentAccess;
  transport: McpTransport;
  name: string;
  endpoint: string;
  secret: string;
  headerName: string;
  headerValue: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthAuthorizationServer: string;
  oauthScope: string;
  oauthParams: string;
  advancedOpen: boolean;
  command: string;
  args: string;
  verbatimResults: boolean;
  envRows: EnvRow[];
};

/** How an env value asks Rakazo to inject the granted OAuth access token. */
const oauthEnvReference = "{{oauth.access_token}}";

let nextEnvRowId = 0;
const emptyEnvRow = (): EnvRow => ({
  id: nextEnvRowId++,
  name: "",
  value: "",
  file: false,
});

/** Environment variable names the server accepts: capitals, digits, and underscores. */
function envName(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^(?=[0-9])/, "_");
}

export function emptyMcpServerDraft(transport: McpTransport): McpServerDraft {
  return {
    access: { allBots: true, botIds: [] },
    transport,
    name: "",
    endpoint: "",
    secret: "",
    headerName: "Authorization",
    headerValue: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthAuthorizationServer: "",
    oauthScope: "",
    oauthParams: "",
    advancedOpen: false,
    command: "",
    args: "",
    verbatimResults: false,
    envRows: [emptyEnvRow()],
  };
}

/** Stored values are never sent back to the client, so a blank one keeps what is stored. */
export function mcpServerDraftFor(
  server: McpServer,
  access: AgentAccess,
  showOAuthClient: boolean,
): McpServerDraft {
  const draft = emptyMcpServerDraft(server.transport);
  const rows = [
    ...server.envKeys.map((name) => ({ ...emptyEnvRow(), name })),
    ...server.fileKeys.map((name) => ({ ...emptyEnvRow(), name, file: true })),
  ];
  return {
    ...draft,
    access,
    name: server.name,
    endpoint: server.endpoint ?? "",
    command: server.command ?? "",
    verbatimResults: server.verbatimResults,
    headerName: server.headerKeys[0] ?? "Authorization",
    envRows: rows.length > 0 ? rows : draft.envRows,
    advancedOpen: showOAuthClient,
  };
}

/** Names entered for more than one environment variable. */
export function duplicateEnvNames(envRows: EnvRow[]): Set<string> {
  return new Set(
    envRows
      .filter(
        (row, index) =>
          row.name &&
          envRows.some(
            (other, otherIndex) =>
              otherIndex !== index && envName(other.name) === envName(row.name),
          ),
      )
      .map((row) => row.name),
  );
}

/** The server config a draft saves; an edit sends blank values for stored headers to keep them. */
export function mcpServerConfig(draft: McpServerDraft, editing: McpServer | null) {
  const slug = deriveMcpSlug(draft.name);
  const headers = {
    ...Object.fromEntries((editing?.headerKeys ?? []).map((key) => [key, ""])),
    ...(draft.headerValue.trim()
      ? { [draft.headerName.trim() || "Authorization"]: draft.headerValue.trim() }
      : {}),
  };
  const oauthBase = draft.oauthClientId.trim()
    ? {
        clientId: draft.oauthClientId.trim(),
        clientSecret: draft.oauthClientSecret || undefined,
        scope: draft.oauthScope.trim() || undefined,
        authorizationParams: draft.oauthParams.trim() || undefined,
      }
    : undefined;
  const envEntries = (file: boolean) =>
    Object.fromEntries(
      draft.envRows
        .filter((row) => row.name && row.file === file)
        .map((row) => [row.name, row.value]),
    );
  return draft.transport === "stdio"
    ? {
        slug,
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.command.trim(),
        args: draft.args.split(/\s+/).filter(Boolean),
        env: envEntries(false),
        files: envEntries(true),
        secret: draft.secret || undefined,
        oauthClient: oauthBase
          ? {
              ...oauthBase,
              authorizationServer: draft.oauthAuthorizationServer.trim(),
            }
          : undefined,
        enabled: true,
        verbatimResults: draft.verbatimResults,
      }
    : {
        slug,
        name: draft.name.trim(),
        transport: draft.transport,
        endpoint: draft.endpoint.trim(),
        headers,
        secret: draft.secret || undefined,
        oauthClient: oauthBase,
        enabled: true,
        verbatimResults: draft.verbatimResults,
      };
}

export function McpServerForm({
  draft,
  setDraft,
  editing,
  canGoBack,
  saving,
  stdioEnabled,
  bots,
  assignmentsReady,
  oauthClientIdInput,
  onBack,
  onSave,
}: {
  draft: McpServerDraft;
  setDraft: Dispatch<SetStateAction<McpServerDraft>>;
  /** The server being edited, or null while adding one. */
  editing: McpServer | null;
  canGoBack: boolean;
  saving: boolean;
  stdioEnabled: boolean;
  bots: Bot[];
  assignmentsReady: boolean;
  oauthClientIdInput: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onSave: () => void;
}) {
  const { t } = useLingui();
  const duplicateNames = duplicateEnvNames(draft.envRows);

  function update(patch: Partial<McpServerDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function setEnvRows(change: (rows: EnvRow[]) => EnvRow[]) {
    setDraft((current) => ({ ...current, envRows: change(current.envRows) }));
  }

  function updateEnvRow(id: number, patch: Partial<EnvRow>) {
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        {canGoBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-ms-2 text-muted-foreground"
            aria-label={t`Back`}
            disabled={saving}
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
        ) : null}
        <SectionHeading variant="heading">
          {editing ? editing.name : <Trans>Add server</Trans>}
        </SectionHeading>
      </div>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="mcp-name">
            <Trans>Server name</Trans>
          </FieldLabel>
          <Input
            id="mcp-name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="e.g. Mobbin"
          />
        </Field>
        <Tabs
          value={draft.transport}
          onValueChange={(value) => update({ transport: value as McpTransport })}
        >
          <TabsList className="w-full">
            <TabsTrigger value="streamable_http">HTTP</TabsTrigger>
            <TabsTrigger value="sse">SSE</TabsTrigger>
            {stdioEnabled || editing?.transport === "stdio" ? (
              <TabsTrigger value="stdio">STDIO</TabsTrigger>
            ) : null}
          </TabsList>
        </Tabs>
        {draft.transport === "stdio" ? (
          <>
            <Field>
              <FieldLabel htmlFor="mcp-command">
                <Trans>Command</Trans>
              </FieldLabel>
              <Input
                id="mcp-command"
                value={draft.command}
                onChange={(e) => update({ command: e.target.value })}
                placeholder="/opt/mcp-server"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-args">
                <Trans>Arguments</Trans>
              </FieldLabel>
              <Input
                id="mcp-args"
                value={draft.args}
                onChange={(e) => update({ args: e.target.value })}
                placeholder={editing?.hasArgs ? t`Stored encrypted` : "--stdio"}
              />
            </Field>
          </>
        ) : (
          <Field>
            <FieldLabel htmlFor="mcp-endpoint">
              <Trans>Server URL</Trans>
            </FieldLabel>
            <Input
              id="mcp-endpoint"
              type="url"
              autoComplete="off"
              value={draft.endpoint}
              onChange={(e) => update({ endpoint: e.target.value })}
              placeholder="https://api.mobbin.com/mcp"
            />
          </Field>
        )}
        <Disclosure
          open={draft.advancedOpen}
          onOpenChange={(advancedOpen) => update({ advancedOpen })}
          className="group rounded-xl border border-border"
          summary={<Trans>Advanced</Trans>}
          summaryClassName="w-full flex items-center justify-between px-3 py-2.5 text-body text-foreground"
        >
          <div className="space-y-4 border-t border-border p-3">
            <Field>
              <FieldLabel htmlFor="mcp-secret">
                <Trans>Access token (optional)</Trans>
              </FieldLabel>
              <Input
                id="mcp-secret"
                type="password"
                autoComplete="new-password"
                value={draft.secret}
                onChange={(e) => update({ secret: e.target.value })}
                placeholder={t`Stored encrypted`}
              />
            </Field>
            {draft.transport === "stdio" ? (
              <Field>
                <FieldTitle>
                  <Trans>Environment variables</Trans>
                </FieldTitle>
                {draft.envRows.map((row) => (
                  <Field
                    key={row.id}
                    orientation="horizontal"
                    data-invalid={duplicateNames.has(row.name) || undefined}
                    className="grid grid-cols-[.7fr_1fr_auto_auto] items-start gap-2"
                  >
                    <Input
                      aria-label={t`Name`}
                      aria-invalid={duplicateNames.has(row.name) || undefined}
                      aria-describedby={
                        duplicateNames.has(row.name) ? `mcp-env-error-${row.id}` : undefined
                      }
                      autoComplete="off"
                      className={row.file ? "col-span-2" : undefined}
                      value={row.name}
                      onChange={(e) =>
                        updateEnvRow(row.id, {
                          name: envName(e.target.value),
                        })
                      }
                      placeholder="API_KEY"
                    />
                    {row.file ? null : (
                      <Input
                        aria-label={t`Value`}
                        type={row.value.includes("{{oauth.") ? "text" : "password"}
                        autoComplete={row.value.includes("{{oauth.") ? "off" : "new-password"}
                        value={row.value}
                        onChange={(e) =>
                          updateEnvRow(row.id, {
                            value: e.target.value,
                          })
                        }
                        placeholder={t`Stored encrypted`}
                      />
                    )}
                    <Toggle
                      variant="outline"
                      size="sm"
                      pressed={row.file}
                      onPressedChange={(file) => updateEnvRow(row.id, { file })}
                    >
                      <Trans>File</Trans>
                    </Toggle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Remove`}
                      onClick={() =>
                        setEnvRows((rows) =>
                          rows.length > 1
                            ? rows.filter((item) => item.id !== row.id)
                            : [emptyEnvRow()],
                        )
                      }
                    >
                      <X />
                    </Button>
                    {row.file ? (
                      <Textarea
                        aria-label={t`Value`}
                        autoComplete="off"
                        spellCheck={false}
                        className="col-span-full min-h-24 font-mono text-label"
                        value={row.value}
                        onChange={(e) =>
                          updateEnvRow(row.id, {
                            value: e.target.value,
                          })
                        }
                      />
                    ) : null}
                    {duplicateNames.has(row.name) ? (
                      <FieldError id={`mcp-env-error-${row.id}`} className="col-span-full">
                        <Trans>Each name can be used once.</Trans>
                      </FieldError>
                    ) : null}
                  </Field>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="self-start"
                  onClick={() => setEnvRows((rows) => [...rows, emptyEnvRow()])}
                >
                  <Trans>Add</Trans>
                </Button>
                {draft.oauthClientId.trim() ? (
                  <p className="text-label text-muted-foreground">
                    <Trans>Use {oauthEnvReference} for the access token.</Trans>
                  </p>
                ) : null}
              </Field>
            ) : (
              <div className="grid grid-cols-[.7fr_1fr] gap-2">
                <Input
                  aria-label={t`Header name`}
                  value={draft.headerName}
                  onChange={(e) => update({ headerName: e.target.value })}
                />
                <Input
                  aria-label={t`Header value`}
                  type="password"
                  autoComplete="new-password"
                  value={draft.headerValue}
                  onChange={(e) => update({ headerValue: e.target.value })}
                  placeholder={t`Optional header value`}
                />
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="mcp-oauth-client-id">
                <Trans>OAuth client ID (optional)</Trans>
              </FieldLabel>
              <Input
                ref={oauthClientIdInput}
                id="mcp-oauth-client-id"
                autoComplete="off"
                value={draft.oauthClientId}
                onChange={(e) => update({ oauthClientId: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-oauth-client-secret">
                <Trans>OAuth client secret (optional)</Trans>
              </FieldLabel>
              <Input
                id="mcp-oauth-client-secret"
                type="password"
                autoComplete="new-password"
                value={draft.oauthClientSecret}
                onChange={(e) => update({ oauthClientSecret: e.target.value })}
                placeholder={t`Stored encrypted`}
              />
            </Field>
            {draft.oauthClientId.trim() ? (
              <>
                {draft.transport === "stdio" ? (
                  <Field>
                    <FieldLabel htmlFor="mcp-oauth-authorization-server">
                      <Trans>Authorization server</Trans>
                    </FieldLabel>
                    <Input
                      id="mcp-oauth-authorization-server"
                      type="url"
                      autoComplete="off"
                      value={draft.oauthAuthorizationServer}
                      onChange={(e) => update({ oauthAuthorizationServer: e.target.value })}
                      placeholder="https://accounts.google.com"
                    />
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="mcp-oauth-scope">
                    <Trans>Scopes (optional)</Trans>
                  </FieldLabel>
                  <Input
                    id="mcp-oauth-scope"
                    autoComplete="off"
                    value={draft.oauthScope}
                    onChange={(e) => update({ oauthScope: e.target.value })}
                    placeholder="openid email"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-oauth-params">
                    <Trans>Authorization parameters (optional)</Trans>
                  </FieldLabel>
                  <Input
                    id="mcp-oauth-params"
                    autoComplete="off"
                    value={draft.oauthParams}
                    onChange={(e) => update({ oauthParams: e.target.value })}
                    placeholder="access_type=offline&prompt=consent"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-oauth-redirect-uri">
                    <Trans>Redirect URI</Trans>
                  </FieldLabel>
                  <Input
                    id="mcp-oauth-redirect-uri"
                    readOnly
                    value={mcpOAuthRedirectUri()}
                    onFocus={(e) => e.target.select()}
                  />
                </Field>
              </>
            ) : null}
            <Field orientation="horizontal">
              <Checkbox
                id="mcp-verbatim-results"
                checked={draft.verbatimResults}
                onCheckedChange={(checked) => update({ verbatimResults: checked === true })}
              />
              <FieldLabel htmlFor="mcp-verbatim-results">
                <Trans>Keep tool results whole</Trans>
              </FieldLabel>
            </Field>
          </div>
        </Disclosure>
      </FieldGroup>
      <AgentAccessControl
        bots={bots}
        access={draft.access}
        disabled={!assignmentsReady}
        onChange={(access) => update({ access })}
      />
      <Button
        type="button"
        className="w-full"
        disabled={saving || (draft.transport === "stdio" && duplicateNames.size > 0)}
        onClick={onSave}
      >
        {editing ? (
          saving ? (
            <Trans>Saving…</Trans>
          ) : (
            <Trans>Save</Trans>
          )
        ) : saving ? (
          <Trans>Adding…</Trans>
        ) : (
          <Trans>Add server</Trans>
        )}
      </Button>
    </div>
  );
}
