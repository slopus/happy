import { Trans } from "@lingui/react/macro";
import { Button, Field, FieldError, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { MemoryProviderAdvanced } from "./MemoryProviderAdvanced";
import type { MemoryProviderSettingsFormProps } from "./registry";
import type { SerenityEndpointFieldError } from "./serenity-settings";
import { SERENITY_ENDPOINT_PLACEHOLDER, serenityConnectionDraft } from "./serenity-settings";

export function SerenitySettingsForm({
  busy,
  onConnect,
  advancedSettings,
}: MemoryProviderSettingsFormProps) {
  const endpointId = useId();
  const endpointErrorId = useId();
  const tokenId = useId();
  const writesLabelId = useId();
  const brainLabelId = useId();
  const [endpoint, setEndpoint] = useState("");
  const [endpointError, setEndpointError] = useState<SerenityEndpointFieldError | null>(null);
  const [token, setToken] = useState("");
  const [brainLabel, setBrainLabel] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);

  async function connect() {
    const result = serenityConnectionDraft({ endpoint, token, brainLabel, allowWrites });
    if (!result.ok) {
      setEndpointError(result.error);
      return;
    }
    if (token.trim().length < 8) return;
    setEndpointError(null);
    if (await onConnect(result.draft)) setToken("");
  }

  return (
    <>
      <Field className="mt-4" data-invalid={endpointError ? true : undefined}>
        <FieldLabel htmlFor={endpointId}>
          <Trans>MCP endpoint</Trans>
        </FieldLabel>
        <Input
          id={endpointId}
          value={endpoint}
          required
          disabled={busy}
          aria-invalid={endpointError ? true : undefined}
          aria-describedby={endpointError ? endpointErrorId : undefined}
          onChange={(event) => {
            setEndpoint(event.target.value);
            setEndpointError(null);
          }}
          placeholder={SERENITY_ENDPOINT_PLACEHOLDER}
          autoComplete="off"
        />
        {endpointError === "required" ? (
          <FieldError id={endpointErrorId}>
            <Trans>Serenity endpoint is required.</Trans>
          </FieldError>
        ) : null}
      </Field>

      <Field className="mt-4">
        <FieldLabel htmlFor={tokenId}>
          <Trans>Bearer token</Trans>
        </FieldLabel>
        <Input
          id={tokenId}
          value={token}
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
          placeholder="sk_live_…"
          type="password"
          autoComplete="new-password"
        />
      </Field>

      <MemoryProviderAdvanced>
        {advancedSettings}
        <Field className="mt-4">
          <FieldLabel htmlFor={brainLabelId}>
            <Trans>Brain label</Trans>
          </FieldLabel>
          <Input
            id={brainLabelId}
            value={brainLabel}
            disabled={busy}
            onChange={(event) => setBrainLabel(event.target.value)}
            placeholder="personal"
            autoComplete="off"
          />
        </Field>

        <Field className="mt-4" aria-labelledby={writesLabelId}>
          <FieldLabel id={writesLabelId}>
            <Trans>Allow writing</Trans>
          </FieldLabel>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            <Toggle
              pressed={!allowWrites}
              disabled={busy}
              onPressedChange={() => setAllowWrites(false)}
              className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              <Trans>Recall only</Trans>
            </Toggle>
            <Toggle
              pressed={allowWrites}
              disabled={busy}
              onPressedChange={() => setAllowWrites(true)}
              className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              <Trans>Recall and write</Trans>
            </Toggle>
          </div>
        </Field>
      </MemoryProviderAdvanced>

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || token.trim().length < 8}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
