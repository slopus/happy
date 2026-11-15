import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { credentialForModel } from "@rakazo/core";
import {
  Button,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import {
  connectedModelOptions,
  parseModelOptionKey,
  thinkingLevelLabel,
} from "../../lib/model-catalog";
import type { RoutineDraftState } from "../../lib/routine-draft";
import { rpc } from "../../lib/rpc";

/** The advanced popover that picks a model and thinking level for this routine. */
export function RoutineModelSettings({
  draft,
  onChange,
  fieldId,
}: {
  draft: RoutineDraftState;
  onChange: (next: RoutineDraftState) => void;
  fieldId: string;
}) {
  const { t } = useLingui();
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  useEffect(() => {
    void Promise.all([rpc.models.credentials(), rpc.models.list()])
      .then(([nextCredentials, nextCatalog]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
      })
      .catch(() => undefined);
  }, []);
  const modelOptions = connectedModelOptions(credentials, catalog);
  const selectedModel = draft.modelKey ? parseModelOptionKey(draft.modelKey) : null;
  const selectedEntry = selectedModel
    ? catalog.find(
        (entry) => entry.provider === selectedModel.provider && entry.id === selectedModel.modelId,
      )
    : undefined;
  const selectedCredential = credentialForModel(
    credentials,
    selectedModel?.provider,
    selectedModel?.modelId,
  );
  const thinkingOptions = (
    selectedCredential?.thinkingLevels ??
    selectedEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultThinkingLevel = selectedCredential?.thinkingLevel ?? "medium";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative ml-auto text-muted-foreground"
            aria-label={t`Advanced`}
            title={t`Advanced`}
          />
        }
      >
        <SlidersHorizontal />
        {draft.modelKey ? (
          <span
            aria-hidden
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground"
          />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-4">
        <label htmlFor={`${fieldId}-model`} className="block text-body text-muted-foreground">
          <Trans>Model</Trans>
          <NativeSelect
            id={`${fieldId}-model`}
            className="mt-2 w-full"
            value={draft.modelKey}
            onChange={(event) =>
              onChange({ ...draft, modelKey: event.target.value, thinkingLevel: "" })
            }
          >
            <NativeSelectOption value="">{t`Bot's model`}</NativeSelectOption>
            {draft.modelKey && !modelOptions.some((option) => option.key === draft.modelKey) ? (
              <NativeSelectOption value={draft.modelKey}>
                {selectedModel?.modelId ?? draft.modelKey}
              </NativeSelectOption>
            ) : null}
            {modelOptions.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>

        {thinkingOptions.length ? (
          <label
            htmlFor={`${fieldId}-thinking`}
            className="mt-5 block text-body text-muted-foreground"
          >
            <Trans>Thinking</Trans>
            <NativeSelect
              id={`${fieldId}-thinking`}
              className="mt-2 w-full"
              value={draft.thinkingLevel}
              onChange={(event) => onChange({ ...draft, thinkingLevel: event.target.value })}
            >
              <NativeSelectOption value="">
                {t`Default (${thinkingLevelLabel(defaultThinkingLevel)})`}
              </NativeSelectOption>
              {thinkingOptions.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
