import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { ConnectionMode } from "./ConnectionModeFields";
import { ConnectionModeFields } from "./ConnectionModeFields";
import { MemoryProviderAdvanced } from "./MemoryProviderAdvanced";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{0,512}$/;
// Rakazo writes to these peers, so they cannot be read as the user's own peer.
function isReservedPeerId(value: string): boolean {
  return value === "rakazo-shared" || value.startsWith("bot-");
}

export function HonchoSettingsForm({
  busy,
  onConnect,
  advancedSettings,
}: MemoryProviderSettingsFormProps) {
  const apiKeyId = useId();
  const workspaceId = useId();
  const workspaceErrorId = useId();
  const [mode, setMode] = useState<ConnectionMode>("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const userPeerId = useId();
  const userPeerErrorId = useId();
  const userPeerDescriptionId = useId();
  const [userPeer, setUserPeer] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState("");
  const workspaceValid = RESOURCE_ID_PATTERN.test(workspace.trim());
  const showUserPeer = workspace.trim().length > 0;
  const userPeerFormatValid = RESOURCE_ID_PATTERN.test(userPeer.trim());
  const userPeerReserved = isReservedPeerId(userPeer.trim());
  const userPeerValid = !showUserPeer || (userPeerFormatValid && !userPeerReserved);
  const ready =
    apiKey.trim().length >= 8 &&
    workspaceValid &&
    userPeerValid &&
    (mode === "cloud" || Boolean(baseUrl.trim()));

  async function connect() {
    if (!ready) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        ...(mode === "local" ? { mode, baseUrl: baseUrl.trim() } : {}),
        ...(showUserPeer && userPeer.trim() ? { userPeerId: userPeer.trim() } : {}),
        ...(workspace.trim() ? { workspaceId: workspace.trim() } : {}),
      },
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={mode === "cloud" ? "hch-…" : undefined}
          type="password"
          autoComplete="new-password"
          maxLength={4096}
        />
      </Field>

      <MemoryProviderAdvanced>
        {advancedSettings}
        <ConnectionModeFields
          busy={busy}
          mode={mode}
          onModeChange={setMode}
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
        />
        <Field className="mt-4" data-invalid={workspaceValid ? undefined : true}>
          <FieldLabel htmlFor={workspaceId}>
            <Trans>Workspace</Trans>
          </FieldLabel>
          <Input
            id={workspaceId}
            value={workspace}
            disabled={busy}
            aria-invalid={workspaceValid ? undefined : true}
            aria-describedby={workspaceValid ? undefined : workspaceErrorId}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="rakazo-<space>"
            maxLength={512}
            autoComplete="off"
          />
          {!workspaceValid ? (
            <FieldError id={workspaceErrorId}>
              <Trans>Use up to 512 letters, digits, _ or -.</Trans>
            </FieldError>
          ) : null}
        </Field>

        {showUserPeer ? (
          <Field className="mt-4" data-invalid={userPeerValid ? undefined : true}>
            <FieldLabel htmlFor={userPeerId}>
              <Trans>User peer</Trans>
            </FieldLabel>
            <Input
              id={userPeerId}
              value={userPeer}
              disabled={busy}
              aria-invalid={userPeerValid ? undefined : true}
              aria-describedby={
                userPeerValid
                  ? userPeerDescriptionId
                  : `${userPeerDescriptionId} ${userPeerErrorId}`
              }
              onChange={(event) => setUserPeer(event.target.value)}
              maxLength={512}
              autoComplete="off"
            />
            <p id={userPeerDescriptionId} className="mt-2 text-body-sm text-muted-foreground">
              <Trans>Recall from this peer; save to Rakazo’s own peers.</Trans>
            </p>
            {!userPeerValid ? (
              <FieldError id={userPeerErrorId}>
                {userPeerFormatValid ? (
                  <Trans>rakazo-shared and IDs starting with bot- are reserved for Rakazo.</Trans>
                ) : (
                  <Trans>Use up to 512 letters, digits, _ or -.</Trans>
                )}
              </FieldError>
            ) : null}
          </Field>
        ) : null}
      </MemoryProviderAdvanced>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !ready}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
