import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { ConnectionMode } from "./ConnectionModeFields";
import { ConnectionModeFields } from "./ConnectionModeFields";
import { MemoryProviderAdvanced } from "./MemoryProviderAdvanced";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

export function SupermemorySettingsForm({
  busy,
  onConnect,
  advancedSettings,
}: MemoryProviderSettingsFormProps) {
  const apiKeyId = useId();
  const [mode, setMode] = useState<ConnectionMode>("cloud");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  async function connect() {
    if (!apiKey.trim()) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        mode,
        ...(mode === "local" ? { baseUrl: baseUrl.trim() } : {}),
      },
      credentials: { apiKey: apiKey.trim() },
    };
    if (await onConnect(draft)) setApiKey("");
  }

  return (
    <>
      <Field className="mt-4">
        <FieldLabel htmlFor={apiKeyId}>
          {mode === "cloud" ? <Trans>Organization API key</Trans> : <Trans>Instance API key</Trans>}
        </FieldLabel>
        <Input
          id={apiKeyId}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sm_…"
          type="password"
          autoComplete="new-password"
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
      </MemoryProviderAdvanced>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || apiKey.trim().length < 8 || (mode === "local" && !baseUrl.trim())}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
