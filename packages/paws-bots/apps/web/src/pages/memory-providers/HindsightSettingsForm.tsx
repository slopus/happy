import { Trans } from "@lingui/react/macro";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import type { ConnectionMode } from "./ConnectionModeFields";
import { ConnectionModeFields } from "./ConnectionModeFields";
import { MemoryProviderAdvanced } from "./MemoryProviderAdvanced";
import type { MemoryProviderConnectionDraft, MemoryProviderSettingsFormProps } from "./registry";

type RecallBudget = "low" | "mid" | "high";

function Segmented<T extends string>({
  label,
  options,
  value,
  busy,
  onChange,
}: {
  label: ReactNode;
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  busy: boolean;
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <Field className="mt-4" aria-labelledby={labelId}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <ToggleGroup
        aria-labelledby={labelId}
        value={[value]}
        disabled={busy}
        spacing={1}
        onValueChange={([next]) => {
          const selected = options.find((option) => option.value === next);
          if (selected) onChange(selected.value);
        }}
        className="grid w-full gap-1 rounded-lg bg-muted p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}

function SwitchRow({
  label,
  checked,
  busy,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  busy: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="mt-4 flex items-center gap-2">
      <Switch id={id} size="sm" checked={checked} disabled={busy} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-body-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

export function HindsightSettingsForm({
  busy,
  onConnect,
  advancedSettings,
}: MemoryProviderSettingsFormProps) {
  const apiKeyId = useId();
  const recallBanksId = useId();
  const [mode, setMode] = useState<ConnectionMode>("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [recallBanks, setRecallBanks] = useState("");
  const [learn, setLearn] = useState(true);
  const [autoRecall, setAutoRecall] = useState(true);
  const [recallBudget, setRecallBudget] = useState<RecallBudget>("mid");
  const [withFacts, setWithFacts] = useState(false);
  const [skipUnrelated, setSkipUnrelated] = useState(false);
  const key = apiKey.trim();
  const banks = recallBanks
    .split(",")
    .map((bank) => bank.trim())
    .filter(Boolean)
    .join(",");
  // A self-hosted server runs without authentication by default.
  const keyOptional = mode === "local";
  const ready =
    (key.length === 0 ? keyOptional : key.length >= 8) &&
    (mode === "cloud" || Boolean(baseUrl.trim()));
  async function connect() {
    if (!ready) return;
    const draft: MemoryProviderConnectionDraft = {
      settings: {
        ...(mode === "local" ? { mode, baseUrl: baseUrl.trim() } : {}),
        ...(banks ? { recallBanks: banks } : {}),
        ...(learn ? {} : { retainConversations: "false" }),
        ...(autoRecall ? {} : { autoRecall: "false" }),
        ...(recallBudget === "mid" ? {} : { recallBudget }),
        ...(withFacts ? { recallFacts: "true" } : {}),
        ...(skipUnrelated ? { skipUnrelated: "true" } : {}),
      },
      credentials: key ? { apiKey: key } : {},
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
        <Field className="mt-4">
          <FieldLabel htmlFor={recallBanksId}>
            <Trans>Recall from banks</Trans>
          </FieldLabel>
          <Input
            id={recallBanksId}
            value={recallBanks}
            disabled={busy}
            onChange={(event) => setRecallBanks(event.target.value)}
            maxLength={2048}
            autoComplete="off"
          />
        </Field>

        <SwitchRow
          label={<Trans>Learn from conversations</Trans>}
          checked={learn}
          busy={busy}
          onChange={setLearn}
        />

        <SwitchRow
          label={<Trans>Recall automatically</Trans>}
          checked={autoRecall}
          busy={busy}
          onChange={setAutoRecall}
        />
        <Segmented
          label={<Trans>Recall depth</Trans>}
          busy={busy}
          value={recallBudget}
          onChange={setRecallBudget}
          options={[
            { value: "low", label: <Trans>Low</Trans> },
            { value: "mid", label: <Trans>Medium</Trans> },
            { value: "high", label: <Trans>High</Trans> },
          ]}
        />
        <Segmented
          label={<Trans>What to recall</Trans>}
          busy={busy}
          value={withFacts ? "facts" : "summaries"}
          onChange={(value) => setWithFacts(value === "facts")}
          options={[
            { value: "summaries", label: <Trans>Summaries</Trans> },
            { value: "facts", label: <Trans>Summaries and facts</Trans> },
          ]}
        />
        <SwitchRow
          label={<Trans>Skip unrelated memories</Trans>}
          checked={skipUnrelated}
          busy={busy}
          onChange={setSkipUnrelated}
        />
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
