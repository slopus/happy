import { Trans } from "@lingui/react/macro";
import { Field, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useId } from "react";

export type ConnectionMode = "cloud" | "local";

/** Hosted service or a self-hosted instance at a base URL. */
export function ConnectionModeFields({
  busy,
  mode,
  onModeChange,
  baseUrl,
  onBaseUrlChange,
}: {
  busy: boolean;
  mode: ConnectionMode;
  onModeChange: (mode: ConnectionMode) => void;
  baseUrl: string;
  onBaseUrlChange: (baseUrl: string) => void;
}) {
  const baseUrlId = useId();
  const connectionLabelId = useId();
  return (
    <>
      <Field className="mt-4" aria-labelledby={connectionLabelId}>
        <FieldLabel id={connectionLabelId}>
          <Trans>Connection</Trans>
        </FieldLabel>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          {(["cloud", "local"] as const).map((option) => (
            <Toggle
              key={option}
              pressed={mode === option}
              disabled={busy}
              onPressedChange={() => onModeChange(option)}
              className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              {option === "cloud" ? <Trans>Cloud</Trans> : <Trans>Self-hosted</Trans>}
            </Toggle>
          ))}
        </div>
      </Field>

      {mode === "local" ? (
        <Field className="mt-4">
          <FieldLabel htmlFor={baseUrlId}>
            <Trans>Base URL</Trans>
          </FieldLabel>
          <Input
            id={baseUrlId}
            value={baseUrl}
            disabled={busy}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="https://…"
          />
        </Field>
      ) : null}
    </>
  );
}
