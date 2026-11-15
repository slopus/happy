import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import {
  Button,
  Input,
  ModelThinkingOptions,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { FoundModelPicker } from "../../components/FoundModelPicker";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../../components/ModelConnectionPreflightNotice";
import { ModelHeadersEditor } from "../../components/ModelHeadersEditor";
import { CompatibleKeyField } from "../model-settings/compatible-key-field";
import type { OnboardingModel } from "./use-onboarding-model";

const CUSTOM_MODEL_OPTION = "__rakazo_custom_model__";

export function ModelStep({ model, fieldId }: { model: OnboardingModel; fieldId: string }) {
  const { t } = useLingui();
  const {
    acceptsKey,
    accountId,
    apiKey,
    cancelOAuthAttempt,
    canSaveModel,
    chooseProvider,
    credits,
    endpointPreset,
    error,
    fundWithCredits,
    gatewayId,
    invalidatePreflight,
    isOpenAiCompatible,
    modelId,
    modelItems,
    modelsForProvider,
    needsGateway,
    needsRouting,
    notice,
    preflightFailure,
    preflightSuccess,
    preflightTarget,
    preflightTesting,
    provider,
    providerItems,
    providerOptions,
    providerValue,
    saveModel,
    selected,
    setAccountId,
    setGatewayId,
    setModelId,
    setThinkingLevel,
    subscriptionSignIn,
    testApiKeyConnection,
    updateApiKey,
  } = model;

  return (
    <div>
      <h1 className="text-display font-medium text-foreground">
        <Trans>Connect a model</Trans>
      </h1>
      <div className="mt-8 block text-body font-medium text-foreground">
        <span>
          <Trans>Provider</Trans>
        </span>
        <Select
          value={providerValue}
          onValueChange={(value) => {
            if (typeof value !== "string" || !value) return;
            chooseProvider(value);
          }}
          items={providerItems}
        >
          <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
            <SelectValue placeholder={t`Choose a provider`} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {providerOptions.main.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
            {providerOptions.main.length && providerOptions.rest.length ? (
              <SelectSeparator />
            ) : null}
            <SelectGroup>
              {providerOptions.rest.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {provider ? (
        <>
          {isOpenAiCompatible ? <CompatibleServerFields model={model} fieldId={fieldId} /> : null}
          {subscriptionSignIn ? <SubscriptionSignIn model={model} /> : null}
          {needsRouting && acceptsKey ? (
            <div className="mt-4 grid gap-4">
              <label
                htmlFor={`${fieldId}-account-id`}
                className="block text-body font-medium text-foreground"
              >
                <Trans>Account ID</Trans>
                <Input
                  id={`${fieldId}-account-id`}
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2"
                />
              </label>
              {needsGateway ? (
                <label
                  htmlFor={`${fieldId}-gateway-id`}
                  className="block text-body font-medium text-foreground"
                >
                  <Trans>Gateway ID</Trans>
                  <Input
                    id={`${fieldId}-gateway-id`}
                    value={gatewayId}
                    onChange={(event) => setGatewayId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          {acceptsKey ? (
            isOpenAiCompatible ? (
              <CompatibleKeyField
                className="mt-4 block text-body text-muted-foreground"
                keyRequired={Boolean(endpointPreset)}
              >
                <Input
                  aria-label={t`API key`}
                  value={apiKey}
                  onChange={(e) => updateApiKey(e.target.value)}
                  required={Boolean(endpointPreset)}
                  placeholder={endpointPreset ? undefined : t`Optional`}
                  type="password"
                  autoComplete="new-password"
                  className="mt-2"
                />
              </CompatibleKeyField>
            ) : (
              <label
                htmlFor={`${fieldId}-api-key`}
                className="mt-4 block text-body font-medium text-foreground"
              >
                {subscriptionSignIn ? <Trans>Or paste an API key</Trans> : <Trans>API key</Trans>}
                <Input
                  id={`${fieldId}-api-key`}
                  value={apiKey}
                  onChange={(e) => updateApiKey(e.target.value)}
                  placeholder="sk-…"
                  type="password"
                  autoComplete="new-password"
                  className="mt-2"
                />
              </label>
            )
          ) : null}
          {acceptsKey && !isOpenAiCompatible && selected?.catalogProbe ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                disabled={preflightTesting || apiKey.trim().length < 8}
                onClick={() => void testApiKeyConnection()}
              >
                {modelPreflightTestingLabel(
                  preflightTesting && preflightTarget === "api-key",
                  "api-key",
                )}
              </Button>
              {preflightTarget === "api-key" ? (
                <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
              ) : null}
            </>
          ) : null}
          {/* The model is chosen once the account is connected; sign-in uses the default. */}
          {!isOpenAiCompatible && acceptsKey && apiKey.trim() ? (
            <div className="mt-6 block text-body text-foreground">
              <span className="font-medium">
                <Trans>Model</Trans>
              </span>
              <Select
                value={selected?.id ?? modelId}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  if (value === modelId) return;
                  cancelOAuthAttempt();
                  setModelId(value);
                  setThinkingLevel(null);
                  invalidatePreflight();
                }}
                items={modelItems}
              >
                <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelsForProvider.map((entry) => (
                      <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </>
      ) : null}
      {notice ? (
        <p className="mt-3 text-body text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="mt-3 text-body text-destructive">{error}</p> : null}
      <Button
        className="mt-6"
        disabled={!credits && !canSaveModel}
        onClick={() => void (credits ? fundWithCredits() : saveModel())}
      >
        <Trans>Continue</Trans>
      </Button>
    </div>
  );
}

/** Server URL, found or typed model id, and advanced options for an OpenAI-compatible server. */
function CompatibleServerFields({ model, fieldId }: { model: OnboardingModel; fieldId: string }) {
  const { t } = useLingui();
  const {
    baseUrl,
    contextWindow,
    headerRows,
    invalidatePreflight,
    manualModelId,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    preflightFailure,
    preflightTarget,
    probeModels,
    probeServerModels,
    probing,
    reasoning,
    resetOpenAiCompatibleProbe,
    setContextWindow,
    setHeaderRows,
    setManualModelId,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelId,
    setReasoning,
    setSupportsImages,
    setThinkingLevel,
    supportsImages,
    thinkingLevel,
    updateBaseUrl,
  } = model;

  return (
    <div className="mt-6 block text-body text-foreground">
      <label htmlFor={`${fieldId}-base-url`} className="block font-medium">
        <Trans>Server URL</Trans>
        <Input
          id={`${fieldId}-base-url`}
          value={baseUrl}
          onChange={(e) => updateBaseUrl(e.target.value)}
          aria-label={t`OpenAI-compatible server URL`}
          placeholder="http://127.0.0.1:8000/v1"
          autoComplete="off"
          className="mt-2"
        />
      </label>
      <div className="mt-3">
        <Button
          variant="outline"
          disabled={probing || !baseUrl.trim()}
          onClick={() => void probeServerModels()}
        >
          {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
        </Button>
        {preflightTarget === "compatible" ? (
          <ModelPreflightFeedback success={null} failure={preflightFailure} />
        ) : null}
      </div>
      <div className="mt-4 block">
        <span className="font-medium">
          <Trans>Model</Trans>
        </span>
        {probeModels.length && !manualModelId ? (
          <FoundModelPicker
            models={probeModels}
            value={modelId}
            onChange={(next) => {
              invalidatePreflight();
              setManualModelId(next === CUSTOM_MODEL_OPTION);
              setModelId(next === CUSTOM_MODEL_OPTION ? "" : next);
            }}
            otherValue={CUSTOM_MODEL_OPTION}
          />
        ) : (
          <Input
            value={modelId}
            onChange={(e) => {
              setManualModelId(true);
              setModelId(e.target.value);
              invalidatePreflight();
            }}
            aria-label={t`Model id`}
            placeholder="exact-model-id"
            className="mt-2"
          />
        )}
        {probeModels.length && manualModelId ? (
          <Button
            variant="link"
            size="xs"
            className="mt-2 px-0 text-muted-foreground"
            onClick={() => {
              setManualModelId(false);
              setModelId(probeModels[0] ?? "");
              invalidatePreflight();
            }}
          >
            <Trans>Use a found model</Trans>
          </Button>
        ) : null}
      </div>
      <ModelThinkingOptions
        reasoning={reasoning}
        onReasoningChange={(value) => {
          setReasoning(value);
          if (!value) setThinkingLevel(null);
        }}
        advancedLabel={t`Advanced`}
        thinkingLabel={t`Supports thinking`}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={(value) => setThinkingLevel(value as ThinkingLevel | null)}
        thinkingLevelOptions={[
          { value: "minimal", label: t`Minimal` },
          { value: "low", label: t`Low` },
          { value: "medium", label: t`Medium` },
          { value: "high", label: t`High` },
          { value: "xhigh", label: t`Extra high` },
          { value: "max", label: t`Max` },
        ]}
        thinkingLevelLabel={t`Reasoning effort`}
        thinkingLevelDefaultLabel={t`Default`}
        maxTokens={maxTokens}
        onMaxTokensChange={setMaxTokens}
        maxTokensLabel={t`Maximum output tokens`}
        contextWindow={contextWindow}
        onContextWindowChange={setContextWindow}
        contextWindowLabel={t`Context limit`}
        supportsImages={supportsImages}
        onSupportsImagesChange={setSupportsImages}
        imagesLabel={t`Supports images`}
        maxImagesPerPrompt={maxImagesPerPrompt}
        onMaxImagesPerPromptChange={setMaxImagesPerPrompt}
        maxImagesLabel={t`Maximum images per request`}
      >
        <ModelHeadersEditor
          rows={headerRows}
          onChange={(rows) => {
            setHeaderRows(rows);
            resetOpenAiCompatibleProbe();
            invalidatePreflight();
          }}
        />
      </ModelThinkingOptions>
    </div>
  );
}

/** Signing in with a subscription: the start button, then the code or link to finish. */
function SubscriptionSignIn({ model }: { model: OnboardingModel }) {
  const { t } = useLingui();
  const {
    beginSelectedSubscriptionSignIn,
    cancelOAuthAttempt,
    codeCopied,
    copyOAuthCode,
    oauth,
    oauthPending,
    pasteCode,
    popupBlocked,
    setPasteCode,
    signInLabel,
    submitOAuthCode,
  } = model;

  return (
    <div className="mt-4">
      {oauth ? (
        <div className="rounded-lg border border-border px-3.5 py-3">
          {oauth.mode === "auth-url" ? (
            <>
              <p className="text-body text-muted-foreground">
                <Trans>
                  Sign in at{" "}
                  <a
                    href={oauth.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline"
                  >
                    {new URL(oauth.verificationUri).hostname}
                  </a>
                  , then paste the code here.
                </Trans>
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Input
                  value={pasteCode}
                  onChange={(e) => setPasteCode(e.target.value)}
                  aria-label={t`Authorization code`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button disabled={!pasteCode.trim()} onClick={() => void submitOAuthCode()}>
                  <Trans>Submit</Trans>
                </Button>
              </div>
              <p className="mt-2 text-body text-muted-foreground">
                <Plural
                  value={Math.ceil(oauth.expiresInSeconds / 60)}
                  one="Waiting for sign-in — the link expires in about # minute."
                  other="Waiting for sign-in — the link expires in about # minutes."
                />
              </p>
            </>
          ) : (
            <>
              <p className="text-body text-muted-foreground">
                {popupBlocked ? (
                  <Trans>
                    Open{" "}
                    <a
                      href={oauth.verificationUri}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline"
                    >
                      {oauth.verificationUri.replace(/^https:\/\//, "")}
                    </a>{" "}
                    and enter this code:
                  </Trans>
                ) : (
                  <Trans>
                    A sign-in tab opened at{" "}
                    <a
                      href={oauth.verificationUri}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline"
                    >
                      {oauth.verificationUri.replace(/^https:\/\//, "")}
                    </a>
                    . Enter this code there — this window keeps waiting:
                  </Trans>
                )}
              </p>
              <div className="mt-2 flex items-center gap-3">
                <p className="font-mono text-heading2 tracking-[0.2em] text-foreground">
                  {oauth.userCode}
                </p>
                <Button variant="outline" size="sm" onClick={() => copyOAuthCode(oauth.userCode)}>
                  {codeCopied ? (
                    <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                  )}
                  {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                </Button>
              </div>
              <p className="mt-2 text-body text-muted-foreground">
                <Plural
                  value={Math.ceil(oauth.expiresInSeconds / 60)}
                  one="Waiting for sign-in — the code expires in about # minute."
                  other="Waiting for sign-in — the code expires in about # minutes."
                />
              </p>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 -ml-2 text-muted-foreground"
            onClick={() => cancelOAuthAttempt()}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : (
        <Button disabled={oauthPending} onClick={() => beginSelectedSubscriptionSignIn()}>
          {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
        </Button>
      )}
    </div>
  );
}
