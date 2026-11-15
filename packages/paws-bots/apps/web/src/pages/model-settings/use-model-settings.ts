import { useLingui } from "@lingui/react/macro";
import type { Me, SettingsScope, ThinkingLevel } from "@rakazo/contracts";
import {
  compatibleEndpointPresets,
  connectionDisplayName,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  matchCompatibleEndpointPreset,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleConnectionReady,
  compatibleModelRows,
  connectionFormFields,
  connectionFormModelId,
  connectionMaxTokensField,
  modelConnectRequest,
  popularModelProvidersFirst,
  savedCompatibleModelIds,
} from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { providerDisplayName } from "../../lib/localized-provider-hint";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import {
  loadStoredModelAuth,
  runModelConnectionPreflight,
} from "../../lib/model-connection-preflight";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { useModelOAuthSignIn } from "../../lib/use-model-oauth-signin";
import { errorText } from "../../lib/user-error";
import { useModelConnectionForm } from "./use-model-connection-form";

const NO_CATALOG: ModelCatalogEntry[] = [];
const NO_CREDENTIALS: never[] = [];

export type ModelConnectIntent = {
  /** False keeps the current main model; the connection is for a fallback or another role. */
  makeDefault: boolean;
  onConnected?: (choice: {
    provider: string;
    modelId: string;
    credentialId?: string;
  }) => void | Promise<void>;
};

/** `scope` is where a connection made for an empty main model becomes that model. */
export function useModelSettings(onClose: () => void, scope: SettingsScope) {
  const rpc = useSpaceRpc();
  const intentRef = useRef<ModelConnectIntent | null>(null);
  // Sign-in finishes later; it keeps the slot it was started for even if the dialog closes.
  const oauthChoiceRef = useRef<{
    choice: { provider: string; modelId: string };
    intent: ModelConnectIntent | null;
  } | null>(null);
  const { t } = useLingui();
  // What the space has is cached, so a revisit paints at once and refreshes behind it.
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const catalogQuery = {
    queryKey: queries.models.list.queryKey(),
    queryFn: () => rpc.models.list(),
  };
  const credentialsQuery = {
    queryKey: queries.models.credentials.queryKey(),
    queryFn: () => rpc.models.credentials(),
  };
  const meQuery = { queryKey: queries.me.queryKey(), queryFn: () => rpc.me() };
  const catalog = useQuery(catalogQuery).data ?? NO_CATALOG;
  const credentials = useQuery(credentialsQuery).data ?? NO_CREDENTIALS;
  const me: Me | null = useQuery(meQuery).data ?? null;
  // The connection the dialog edits; null connects a new one.
  const [credentialId, setCredentialIdState] = useState<string | null>(null);
  const credentialIdRef = useRef(credentialId);
  const setCredentialId = (next: string | null) => {
    credentialIdRef.current = next;
    setCredentialIdState(next);
  };
  const credential = credentialId
    ? credentials.find((entry) => entry.id === credentialId)
    : undefined;
  const form = useModelConnectionForm({ rpc, catalog, credential });
  const {
    accountId,
    apiKey,
    apiProtocol,
    applyFields,
    baseUrl,
    contextWindow,
    enabledModelIds,
    gatewayId,
    headerRows,
    invalidatePreflight,
    needsRouting,
    isOpenAiCompatible,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    modelProbe,
    modelsForProvider,
    openConnection,
    probeModels,
    provider,
    reasoning,
    resetOpenAiCompatibleProbe,
    runPreflight,
    selected,
    setApiKey,
    setError,
    setHeaderRows,
    setModelId,
    setNotice,
    setProvider,
    setThinkingLevel,
    supportsImages,
    thinkingLevel,
  } = form;
  const [codeCopied, copyOAuthCode] = useCopyText();
  const [loading, setLoading] = useState(
    () =>
      queryClient.getQueryData(catalogQuery.queryKey) === undefined ||
      queryClient.getQueryData(credentialsQuery.queryKey) === undefined ||
      queryClient.getQueryData(meQuery.queryKey) === undefined,
  );
  const [pending, setPending] = useState<"connect" | "settings" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const refreshRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const formRevisionRef = useRef(0);
  const selectedLabelRef = useRef<string | undefined>(undefined);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async (_controller, credentialId) => {
      // A new account's later saves update it rather than adding another.
      setCredentialId(credentialId);
      await refresh();
      const started = oauthChoiceRef.current;
      oauthChoiceRef.current = null;
      if (started) await started.intent?.onConnected?.({ ...started.choice, credentialId });
    },
  });

  /**
   * `keepForm` reloads the lists without resetting the open connection's fields. Every refresh but
   * the one on open follows a change, so by default it never reuses a read sent before that change.
   */
  async function refresh({
    keepForm = false,
    reuse = false,
  }: {
    keepForm?: boolean;
    reuse?: boolean;
  } = {}) {
    const refreshRevision = ++refreshRevisionRef.current;
    const selectionRevision = keepForm ? -1 : selectionRevisionRef.current;
    const [nextCatalog, nextCredentials, nextMe] = await Promise.all([
      fetchFresh(queryClient, catalogQuery, { reuse }),
      fetchFresh(queryClient, credentialsQuery, { reuse }),
      fetchFresh(queryClient, meQuery, { reuse }),
    ]);
    if (refreshRevision !== refreshRevisionRef.current) return undefined;
    applyLoaded(nextCatalog, nextCredentials, nextMe, selectionRevision);
    return nextCredentials;
  }

  /** Points the form at the saved choice, unless the user picked something since the load began. */
  function applyLoaded(
    nextCatalog: ModelCatalogEntry[],
    nextCredentials: typeof credentials,
    nextMe: Me,
    selectionRevision: number,
  ) {
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextCredential = credentialIdRef.current
      ? nextCredentials.find((entry) => entry.id === credentialIdRef.current)
      : undefined;
    // A connection removed elsewhere leaves the dialog connecting a new one.
    if (credentialIdRef.current && !nextCredential) setCredentialId(null);
    const nextModel = connectionFormModelId({
      catalog: nextCatalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: nextMe,
      current: modelId,
    });
    if (selectionRevision === selectionRevisionRef.current) {
      invalidatePreflight();
      resetOpenAiCompatibleProbe();
      setProvider(nextProvider);
      setModelId(nextModel);
      setHeaderRows(null);
      applyFields(
        connectionFormFields({
          catalog: nextCatalog,
          provider: nextProvider,
          modelId: nextModel,
          credential: nextCredential,
        }),
      );
    }
  }

  useLayoutEffect(() => {
    const cachedCatalog = queryClient.getQueryData(catalogQuery.queryKey);
    const cachedCredentials = queryClient.getQueryData(credentialsQuery.queryKey);
    const cachedMe = queryClient.getQueryData(meQuery.queryKey);
    // Before paint, so a revisit opens on the saved choice rather than an empty form.
    if (cachedCatalog && cachedCredentials && cachedMe) {
      applyLoaded(cachedCatalog, cachedCredentials, cachedMe, selectionRevisionRef.current);
    }
    void refresh({ reuse: true })
      .catch((err: unknown) => setError(errorText(err, t`Could not load model settings`)))
      .finally(() => setLoading(false));
    return () => {
      refreshRevisionRef.current += 1;
      modelProbe.invalidate();
    };
  }, []);

  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return popularModelProvidersFirst(
      [...grouped].map(([id, entries]) => ({
        id,
        name: providerDisplayName(
          id,
          entries[0]?.providerName ?? id,
          credentials.find((entry) => entry.provider === id)?.authKind,
        ),
        entries,
      })),
      (group) => group.id,
      (group) => group.name,
    );
  }, [catalog, credentials]);
  const credentialByProvider = useMemo(
    () => new Map(credentials.map((entry) => [entry.provider, entry])),
    [credentials],
  );
  selectedLabelRef.current = selected?.label;
  const endpointPresets = useMemo(() => compatibleEndpointPresets(catalog), [catalog]);
  // A hosted preset needs its key, so the form asks for it up front.
  const endpointPreset = matchCompatibleEndpointPreset(endpointPresets, baseUrl);
  const selectedProviderName =
    endpointPreset?.name ?? groups.find((group) => group.id === provider)?.name ?? provider;
  const selectedConnectionName = credential
    ? connectionDisplayName(
        credential,
        groups.find((group) => group.id === provider)?.name ?? provider,
        modelsForProvider[0]?.providerName ? [modelsForProvider[0].providerName] : [],
      )
    : selectedProviderName;
  const disconnectName = selectedConnectionName;
  const hostCredentialSource = me?.hostCredentialSource ?? "";
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  // Space still bills the host while this provider matches; model id alone is not credentials.
  const usingServerCredentials = provider === me?.hostCredentialProvider;
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // per-bot Thinking picker.
  const catalogThinkingLevels =
    !isOpenAiCompatible && selected
      ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const busy = pending !== null || oauthPending;
  const savedHeaderEndpointMatches = savedCompatibleEndpointMatches(baseUrl, credential?.baseUrl);
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = compatibleConnectionReady({
    apiKey,
    baseUrl,
    modelId,
    headerRows,
    credential,
    keyRequired: Boolean(endpointPreset),
  });
  const compatibleRows = compatibleModelRows(
    savedCompatibleModelIds(credential, baseUrl),
    enabledModelIds,
    probeModels,
  );
  const defaultModelOptions = [...new Set([...enabledModelIds, modelId])];
  // Saved-connection settings edited without a new key (output limit, gateway ids).
  const settingsDirty =
    !isOpenAiCompatible &&
    Boolean(credential) &&
    (maxTokens.trim() !== connectionMaxTokensField(provider, credential?.maxTokens) ||
      (needsRouting &&
        (accountId.trim() !== (credential?.accountId ?? "") ||
          gatewayId.trim() !== (credential?.gatewayId ?? ""))));

  /** Opens a connection (by id) or a new one (null) for the provider. */
  function chooseProvider(
    nextProvider: string,
    presetBaseUrl?: string,
    targetCredentialId: string | null = null,
  ) {
    cancelOAuthAttempt();
    formRevisionRef.current += 1;
    selectionRevisionRef.current += 1;
    const nextCredential = targetCredentialId
      ? credentials.find((entry) => entry.id === targetCredentialId)
      : undefined;
    setCredentialId(nextCredential?.id ?? null);
    const nextModelId = connectionFormModelId({
      catalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: me,
    });
    openConnection(
      nextProvider,
      nextModelId,
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        credential: nextCredential,
        presetBaseUrl,
      }),
    );
  }

  async function testOAuthConnection() {
    if (!selected) return;
    await runPreflight("sign-in", async (stillCurrent) => {
      const stored = await loadStoredModelAuth(
        selected.provider,
        () => rpc.models.credentials(),
        selected.id,
        credentialIdRef.current,
      );
      if (!stillCurrent()) return undefined;
      const result = await runModelConnectionPreflight({
        authKind: "oauth",
        provider: selected.provider,
        ...stored,
      });
      return result.ok
        ? { success: t`A subscription credential is stored securely.` }
        : { failure: result.failure };
    });
  }

  // settingsOnly saves a connected catalog provider's limits and gateway ids
  // without touching the key field; key replacement stays on its own button.
  async function connectKey({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
    if (!selected) return;
    // Closing the dialog mid-save must not drop the slot this connection is for.
    const intent = intentRef.current;
    const request = modelConnectRequest({
      form: {
        apiKey,
        modelId,
        enabledModelIds,
        baseUrl,
        apiProtocol,
        headerRows,
        reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages,
        maxImagesPerPrompt,
        accountId,
        gatewayId,
      },
      selected,
      credential,
      credentialId: credential?.id ?? null,
      settingsOnly,
      ...(intent ? { makeDefault: { makeDefault: intent.makeDefault, scope } } : {}),
    });
    if (request.status === "incomplete") return;
    if (request.status === "invalid") {
      setError(
        request.field === "maxTokens"
          ? t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`
          : request.field === "maxImagesPerPrompt"
            ? t`Enter a whole number from 1 to 1000 for the image limit.`
            : t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      );
      return;
    }
    const { input, savingLimitOnly, activeModelId } = request;
    setError(null);
    setNotice(null);
    setPending(settingsOnly ? "settings" : "connect");
    // Opening another connection while this saves leaves that form alone; field edits
    // in this form still adopt the connection the save creates.
    const form = formRevisionRef.current;
    const stillSelected = () => form === formRevisionRef.current;
    try {
      const saved = await rpc.models.connect(input);
      if (!stillSelected()) {
        await refresh({ keepForm: true });
        return;
      }
      // Saving again edits the connection just made instead of adding another.
      if (saved?.id) setCredentialId(saved.id);
      if (!settingsOnly) setApiKey("");
      await refresh();
      if (!stillSelected()) return;
      if (!settingsOnly)
        await intent?.onConnected?.({
          provider: selected.provider,
          modelId: activeModelId,
          credentialId: saved?.id,
        });
      // A fresh connection speaks for itself through the Active model row.
      if (isOpenAiCompatible || savingLimitOnly) setNotice(t`Saved.`);
    } catch (err) {
      if (stillSelected()) setError(errorText(err, t`Could not connect this provider`));
    } finally {
      setPending(null);
    }
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuthAttempt();
    setError(null);
    setNotice(null);
    setPending("disconnect");
    try {
      await rpc.models.disconnect({ provider: selected.provider, credentialId: credential.id });
      setCredentialId(null);
      setApiKey("");
      setThinkingLevel(null);
      await refresh();
      setNotice(t`Disconnected ${disconnectName}.`);
    } catch (err) {
      setError(errorText(err, t`Could not disconnect this provider`));
    } finally {
      setPending(null);
    }
  }

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected) return;
    setNotice(null);
    const intent = intentRef.current;
    oauthChoiceRef.current = {
      choice: { provider: selected.provider, modelId: selected.id },
      intent,
    };
    void startSubscriptionSignIn({
      provider: selected.provider,
      credentialId: credential?.id ?? null,
      modelId: selected.id,
      ...(intent ? { makeDefault: intent.makeDefault, scope } : {}),
      thinkingLevel: clampCatalogThinkingLevel(
        thinkingLevel,
        selected.thinkingLevels,
      ) as ThinkingLevel | null,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    ...form,
    intentRef,
    refresh,
    savedHeaderEndpointMatches,
    acceptsKey,
    beginSelectedSubscriptionSignIn,
    busy,
    cancelOAuthAttempt,
    catalog,
    catalogThinkingLevels,
    chooseProvider,
    codeCopied,
    compatibleRows,
    confirmDisconnect,
    connectKey,
    copyOAuthCode,
    credential,
    credentialByProvider,
    credentials,
    currentEntry,
    defaultModelOptions,
    disconnectCredential,
    disconnectName,
    endpointPreset,
    endpointPresets,
    effectiveBaseUrl,
    groups,
    handleClose,
    hostCredentialSource,
    loading,
    me,
    oauth,
    oauthPending,
    openAiCompatibleReady,
    pasteCode,
    pending,
    popupBlocked,
    selectedConnectionName,
    selectedProviderName,
    selectionRevisionRef,
    setConfirmDisconnect,
    setPasteCode,
    settingsDirty,
    submitOAuthCode,
    subscriptionSignIn,
    testOAuthConnection,
    usingServerCredentials,
  };
}
export type ModelSettingsState = ReturnType<typeof useModelSettings>;
