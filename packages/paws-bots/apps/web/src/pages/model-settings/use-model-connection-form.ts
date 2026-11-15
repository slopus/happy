import type {
  ModelApiProtocol,
  ModelCredential,
  ModelHeaderRow,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  modelHeadersInput,
  modelRoutingForm,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleProbeSuccessMessage,
} from "@rakazo/contracts";
import type { ConnectionFormFields } from "@rakazo/core";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  createModelProbe,
  initialModelProbeState,
  savedCompatibleModelIds,
} from "@rakazo/core";
import { useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import type { ModelPreflightFailure } from "../../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "../../lib/model-connection-preflight";
import type { RpcClient } from "../../lib/rpc";

type PreflightOutcome = { success: string } | { failure: ModelPreflightFailure };

/**
 * The fields, endpoint probe and connection test shared by every form that connects a model.
 * `credential` is the saved connection being edited, if any; the caller owns saving.
 */
export function useModelConnectionForm({
  rpc,
  catalog,
  credential,
  onModelsFound,
}: {
  rpc: RpcClient;
  catalog: readonly ModelCatalogEntry[];
  credential?: ModelCredential;
  /** Runs after a current probe lists the endpoint's models, with the id typed before it. */
  onModelsFound?: (models: string[], typedModelId: string) => void;
}) {
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<
    "api-key" | "sign-in" | "compatible" | null
  >(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  // The catalog names the IDs a provider needs besides its key.
  const { needsRouting, needsGateway, routingReady } = modelRoutingForm(selected?.routingFields, {
    accountId,
    gatewayId,
  });

  function applyFields(fields: ConnectionFormFields) {
    setEnabledModelIds(fields.enabledModelIds);
    setBaseUrl(fields.baseUrl);
    setApiProtocol(fields.apiProtocol);
    setReasoning(fields.reasoning);
    setThinkingLevel(fields.thinkingLevel);
    setMaxTokens(fields.maxTokens);
    setContextWindow(fields.contextWindow);
    setSupportsImages(fields.supportsImages);
    setMaxImagesPerPrompt(fields.maxImagesPerPrompt);
    setAccountId(fields.accountId);
    setGatewayId(fields.gatewayId);
  }

  function invalidatePreflight() {
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  /** Points the form at another provider's connection, clearing the key and any results. */
  function openConnection(nextProvider: string, nextModelId: string, fields: ConnectionFormFields) {
    setProvider(nextProvider);
    setModelId(nextModelId);
    applyFields(fields);
    setApiKey("");
    setHeaderRows(null);
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // A new endpoint starts with no ticks; the saved endpoint gets its saved list back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
  }

  function updateApiProtocol(nextProtocol: ModelApiProtocol) {
    setApiProtocol(nextProtocol);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        thinkingLevel,
        reasoning ? compatibleThinkingLevels(nextProtocol) : [],
      ) as ThinkingLevel | null,
    );
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
  }

  function stageCompatibleModelId(nextModelId: string) {
    setModelId(nextModelId);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        credential?.modelId === nextModelId ? credential.thinkingLevel : null,
        reasoning ? compatibleThinkingLevels(apiProtocol) : [],
      ) as ThinkingLevel | null,
    );
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    const revision = preflightRevisionRef.current;
    const stillCurrent = () => revision === preflightRevisionRef.current;
    setError(null);
    setNotice(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setPreflightTarget("compatible");
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: (input) =>
        rpc.models.probeOpenAiCompatible({
          ...input,
          apiProtocol,
          headers: modelHeadersInput(headerRows),
          credentialId: credential?.id,
        }),
      onSuccess: (models) => {
        if (!stillCurrent()) return;
        const current = modelIdRef.current;
        const next = current.trim() || models[0] || "";
        if (next !== current) stageCompatibleModelId(next);
        else setModelId(next);
        onModelsFound?.(models, current.trim());
        const unavailable = unavailableSelectedModel(current, models);
        if (unavailable) {
          setPreflightFailure(unavailable);
          setNotice(null);
          return;
        }
        setPreflightTarget(null);
        setPreflightFailure(null);
        setNotice(openAiCompatibleProbeSuccessMessage(models.length));
      },
      onError: (err) => {
        if (!stillCurrent()) return;
        setPreflightFailure(classifyModelConnectionFailure(err, { modelId }));
        setNotice(null);
      },
    });
  }

  /** Shows `test`'s result unless the form changed while it ran; `test` may stop early the same way. */
  async function runPreflight(
    target: "api-key" | "sign-in",
    test: (stillCurrent: () => boolean) => Promise<PreflightOutcome | undefined>,
  ) {
    const revision = preflightRevisionRef.current;
    const stillCurrent = () => revision === preflightRevisionRef.current;
    setPreflightTarget(target);
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const outcome = await test(stillCurrent);
    if (!outcome || !stillCurrent()) return;
    setPreflightTesting(false);
    if ("success" in outcome) setPreflightSuccess(outcome.success);
    else setPreflightFailure(outcome.failure);
  }

  async function testApiKeyConnection() {
    if (!selected?.catalogProbe) return;
    await runPreflight("api-key", async () => {
      const result = await runModelConnectionPreflight({
        authKind: "api-key",
        provider: selected.provider,
        apiKey,
        modelId: selected.id,
        catalogProbe: true,
        probeCatalog: rpc.models.probeCatalog,
      });
      return result.ok
        ? { success: modelPreflightSuccessMessage(result.discoveredModels.length) }
        : { failure: result.failure };
    });
  }

  return {
    accountId,
    apiKey,
    apiProtocol,
    applyFields,
    baseUrl,
    routingReady,
    contextWindow,
    enabledModelIds,
    error,
    gatewayId,
    headerRows,
    invalidatePreflight,
    needsRouting,
    needsGateway,
    isOpenAiCompatible,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    modelProbe,
    modelsForProvider,
    notice,
    openConnection,
    preflightFailure,
    preflightSuccess,
    preflightTarget,
    preflightTesting,
    probeModels,
    probeServerModels,
    probing,
    provider,
    reasoning,
    resetOpenAiCompatibleProbe,
    runPreflight,
    selected,
    setAccountId,
    setApiKey,
    setContextWindow,
    setEnabledModelIds,
    setError,
    setGatewayId,
    setHeaderRows,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelId,
    setNotice,
    setProvider,
    setReasoning,
    setSupportsImages,
    setThinkingLevel,
    stageCompatibleModelId,
    supportsImages,
    testApiKeyConnection,
    thinkingLevel,
    updateApiKey,
    updateApiProtocol,
    updateBaseUrl,
  };
}
