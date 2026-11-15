import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { compatibleThinkingLevels, toggleEnabledModelId } from "@rakazo/core";
import {
  Button,
  Checkbox,
  Disclosure,
  Input,
  Label,
  ListSearchInput,
  ModelThinkingOptions,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { ModelPreflightFeedback } from "../../components/ModelConnectionPreflightNotice";
import { ModelHeadersEditor } from "../../components/ModelHeadersEditor";
import { useListSearch } from "../../lib/use-list-search";

import type { ModelSettingsState } from "./use-model-settings";

export function CompatibleModelFields({
  resetOpenAiCompatibleProbe,
  headerRows,
  setHeaderRows,
  savedHeaderEndpointMatches,
  credential,
  apiProtocol,
  baseUrl,
  busy,
  cancelOAuthAttempt,
  compatibleRows,
  contextWindow,
  defaultModelOptions,
  effectiveBaseUrl,
  enabledModelIds,
  endpointPreset,
  invalidatePreflight,
  maxImagesPerPrompt,
  maxTokens,
  modelId,
  preflightFailure,
  preflightTarget,
  probeModels,
  probeServerModels,
  probing,
  reasoning,
  selectionRevisionRef,
  setContextWindow,
  setEnabledModelIds,
  setError,
  setMaxImagesPerPrompt,
  setMaxTokens,
  setNotice,
  setReasoning,
  setSupportsImages,
  setThinkingLevel,
  stageCompatibleModelId,
  supportsImages,
  thinkingLevel,
  updateApiProtocol,
  updateBaseUrl,
}: Pick<
  ModelSettingsState,
  | "resetOpenAiCompatibleProbe"
  | "headerRows"
  | "setHeaderRows"
  | "savedHeaderEndpointMatches"
  | "credential"
  | "apiProtocol"
  | "baseUrl"
  | "busy"
  | "cancelOAuthAttempt"
  | "compatibleRows"
  | "contextWindow"
  | "defaultModelOptions"
  | "effectiveBaseUrl"
  | "enabledModelIds"
  | "endpointPreset"
  | "invalidatePreflight"
  | "maxImagesPerPrompt"
  | "maxTokens"
  | "modelId"
  | "preflightFailure"
  | "preflightTarget"
  | "probeModels"
  | "probeServerModels"
  | "probing"
  | "reasoning"
  | "selectionRevisionRef"
  | "setContextWindow"
  | "setEnabledModelIds"
  | "setError"
  | "setMaxImagesPerPrompt"
  | "setMaxTokens"
  | "setNotice"
  | "setReasoning"
  | "setSupportsImages"
  | "setThinkingLevel"
  | "stageCompatibleModelId"
  | "supportsImages"
  | "thinkingLevel"
  | "updateApiProtocol"
  | "updateBaseUrl"
>) {
  const { t } = useLingui();
  const thinkingLevelLabels = {
    minimal: t`Minimal`,
    low: t`Low`,
    medium: t`Medium`,
    high: t`High`,
    xhigh: t`Extra high`,
    max: t`Max`,
  } as const;
  const {
    query,
    setQuery,
    showSearch,
    visible: visibleRows,
    hiddenSelectedCount,
  } = useListSearch(compatibleRows, {
    text: (id) => id,
    id: (id) => id,
    selectedIds: [modelId, ...enabledModelIds],
  });
  const hasSearchQuery = query.trim().length > 0;
  return (
    <div className="block text-body text-muted-foreground">
      <label className="block" htmlFor="model-base-url">
        <Trans>Server URL</Trans>
        <Input
          id="model-base-url"
          value={baseUrl}
          onChange={(event) => updateBaseUrl(event.target.value)}
          aria-label={t`OpenAI-compatible server URL`}
          placeholder="http://127.0.0.1:8000/v1"
          autoComplete="off"
          className="mt-2 h-10 text-foreground"
        />
      </label>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || probing || !effectiveBaseUrl}
          onClick={() => void probeServerModels()}
        >
          {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
        </Button>
      </div>
      {!endpointPreset ? (
        <Disclosure
          className="mt-3 text-body text-muted-foreground"
          summary={<Trans>Setup help</Trans>}
        >
          <p className="mt-1">
            {t`Paste the OpenAI-compatible address from your server. Rakazo adds /v1 if needed.`}
          </p>
        </Disclosure>
      ) : null}
      <div className="mt-4 block">
        <label className="block" htmlFor="model-protocol">
          <Trans>Protocol</Trans>
          <NativeSelect
            id="model-protocol"
            className="mt-2 w-full text-foreground"
            value={apiProtocol}
            disabled={busy}
            onChange={(event) => {
              selectionRevisionRef.current += 1;
              updateApiProtocol(event.target.value as ModelSettingsState["apiProtocol"]);
              setError(null);
              setNotice(null);
            }}
            aria-label={t`Protocol`}
          >
            <NativeSelectOption value="chat-completions">
              <Trans>Chat Completions</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="responses">
              <Trans>Responses</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="anthropic-messages">
              <Trans>Anthropic Messages</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </label>
      </div>
      {preflightTarget === "compatible" ? (
        <ModelPreflightFeedback success={null} failure={preflightFailure} />
      ) : null}
      <div className="mt-4 block">
        <span>
          <Trans>Model</Trans>
        </span>
        {compatibleRows.includes(modelId) ? (
          <NativeSelect
            className="mt-2 w-full text-foreground"
            value={modelId}
            onChange={(event) => {
              cancelOAuthAttempt();
              selectionRevisionRef.current += 1;
              invalidatePreflight();
              stageCompatibleModelId(event.target.value);
              setError(null);
              setNotice(null);
            }}
            aria-label={t`Models from server`}
          >
            {defaultModelOptions.map((id) => (
              <NativeSelectOption key={id} value={id}>
                {id}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="">
              <Trans>Other model…</Trans>
            </NativeSelectOption>
          </NativeSelect>
        ) : (
          <Input
            value={modelId}
            onChange={(event) => {
              cancelOAuthAttempt();
              selectionRevisionRef.current += 1;
              invalidatePreflight();
              stageCompatibleModelId(event.target.value);
              setError(null);
              setNotice(null);
            }}
            aria-label={t`Model id`}
            placeholder="exact-model-id"
            className="mt-2 h-10 text-foreground"
          />
        )}
        {compatibleRows.length || hasSearchQuery ? (
          <div className="mt-3 grid gap-2" data-testid="compatible-model-rows">
            {showSearch ? (
              <ListSearchInput
                query={query}
                setQuery={setQuery}
                label={t`Search models`}
                placeholder={t`Search`}
              />
            ) : null}
            {hiddenSelectedCount > 0 ? (
              <p className="text-body-sm leading-[1.5] text-muted-foreground">
                <Plural
                  value={hiddenSelectedCount}
                  one="# selected model is hidden by your search."
                  other="# selected models are hidden by your search."
                />
              </p>
            ) : null}
            {visibleRows.map((id) => (
              <Label key={id} className="font-normal text-foreground">
                <Checkbox
                  checked={id === modelId || enabledModelIds.includes(id)}
                  disabled={busy || id === modelId}
                  onCheckedChange={(checked) => {
                    selectionRevisionRef.current += 1;
                    setEnabledModelIds((current) => toggleEnabledModelId(current, id, checked));
                    setNotice(null);
                  }}
                />
                <span className="min-w-0 break-all">{id}</span>
              </Label>
            ))}
            {visibleRows.length ? null : (
              <p>
                <Trans>No matching models</Trans>
              </p>
            )}
          </div>
        ) : null}
        {probeModels.length && !compatibleRows.includes(modelId) ? (
          <Button
            type="button"
            variant="link"
            className="mt-2 h-auto px-0 text-body-sm leading-[1.5] text-muted-foreground underline"
            onClick={() => {
              invalidatePreflight();
              stageCompatibleModelId(probeModels[0] ?? "");
            }}
          >
            <Trans>Use a found model</Trans>
          </Button>
        ) : null}
      </div>
      <ModelThinkingOptions
        reasoning={reasoning}
        onReasoningChange={(value) => {
          selectionRevisionRef.current += 1;
          setReasoning(value);
          if (!value) setThinkingLevel(null);
          setNotice(null);
        }}
        disabled={busy}
        advancedLabel={t`Advanced`}
        thinkingLabel={t`Supports thinking`}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={(value) => {
          selectionRevisionRef.current += 1;
          setThinkingLevel(value as ThinkingLevel | null);
          setNotice(null);
        }}
        thinkingLevelOptions={compatibleThinkingLevels(apiProtocol).map((level) => ({
          value: level,
          label: thinkingLevelLabels[level],
        }))}
        thinkingLevelLabel={t`Reasoning effort`}
        thinkingLevelDefaultLabel={t`Default`}
        maxTokens={maxTokens}
        onMaxTokensChange={(value) => {
          selectionRevisionRef.current += 1;
          setMaxTokens(value);
          setNotice(null);
        }}
        maxTokensLabel={t`Maximum output tokens`}
        contextWindow={contextWindow}
        onContextWindowChange={(value) => {
          selectionRevisionRef.current += 1;
          setContextWindow(value);
          setNotice(null);
        }}
        contextWindowLabel={t`Context limit`}
        supportsImages={supportsImages}
        onSupportsImagesChange={(value) => {
          selectionRevisionRef.current += 1;
          setSupportsImages(value);
          setNotice(null);
        }}
        imagesLabel={t`Supports images`}
        maxImagesPerPrompt={maxImagesPerPrompt}
        onMaxImagesPerPromptChange={(value) => {
          selectionRevisionRef.current += 1;
          setMaxImagesPerPrompt(value);
          setNotice(null);
        }}
        maxImagesLabel={t`Maximum images per request`}
      >
        <ModelHeadersEditor
          rows={headerRows}
          savedNames={savedHeaderEndpointMatches ? credential?.headerNames : []}
          disabled={busy}
          onChange={(rows) => {
            setHeaderRows(rows);
            resetOpenAiCompatibleProbe();
            invalidatePreflight();
            setNotice(null);
          }}
        />
      </ModelThinkingOptions>
    </div>
  );
}
