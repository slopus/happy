import { Trans, useLingui } from "@lingui/react/macro";
import type {
  SettingsScope,
  VoiceCatalogEntry,
  VoiceCredential,
  VoiceInfo,
  VoiceStatus,
} from "@rakazo/contracts";
import {
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  voiceConnectionForm,
} from "@rakazo/contracts";
import { fetchFresh } from "@rakazo/core/query";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useCallSession } from "../lib/call-session";
import { useSpaceQueries } from "../lib/query";
import { useBoundSpaceId, useSpaceRpc } from "../lib/space-rpc";
import { speaker } from "../lib/tts";
import { errorText } from "../lib/user-error";

export function VoiceSettingsOverlay({
  onClose,
  embedded = false,
  onBusyChange,
  scope,
}: {
  onClose: () => void;
  /** Render the content only, inside the shared Settings shell's scroller. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /**
   * The account's voice, or the bound Space's own when it overrides it. Connections are
   * account-wide, so a Space only picks among them and connects missing ones.
   */
  scope: SettingsScope;
}) {
  const rpc = useSpaceRpc();
  const spaceId = useBoundSpaceId() ?? null;
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const scoped = { input: { scope } };
  // A revisit opens with what this scope showed last time and refreshes it in the background.
  const [cached] = useState(() => {
    const catalog = queryClient.getQueryData(queries.voice.catalog.queryKey());
    const credentials = queryClient.getQueryData(queries.voice.credentials.queryKey(scoped));
    const status = queryClient.getQueryData(queries.voice.status.queryKey(scoped));
    if (!catalog || !credentials || !status) return null;
    const provider = selectedProvider(catalog, [status.provider]);
    const credential = credentials.find((entry) => entry.provider === provider);
    const voices = credential
      ? (queryClient.getQueryData(queries.voice.voices.queryKey({ input: { provider, scope } })) ??
        [])
      : [];
    return { catalog, credentials, status, provider, credential, voices };
  });
  const { t } = useLingui();
  const call = useCallSession();
  const apiKeyId = useId();
  const voiceSelectId = useId();
  const speechModelId = useId();
  const baseUrlId = useId();
  const ttsModelId = useId();
  const sttModelId = useId();
  const providerSelectId = useId();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>(cached?.catalog ?? []);
  const [credentials, setCredentials] = useState<VoiceCredential[]>(cached?.credentials ?? []);
  const [status, setStatus] = useState<VoiceStatus | null>(cached?.status ?? null);
  const [provider, setProvider] = useState(cached?.provider ?? "");
  // The provider being edited, read by loads that finish after the user picked another one.
  const providerRef = useRef(provider);
  // Fields the user changed since the form was last filled; a background refresh keeps them.
  const edited = useRef(new Set<EditableField>());
  // Each list remembers its provider, so one provider's voices never show under another.
  const [voiceList, setVoiceList] = useState<{ provider: string; voices: VoiceInfo[] }>({
    provider: cached?.provider ?? "",
    voices: cached?.voices ?? [],
  });
  const voices = voiceList.provider === provider ? voiceList.voices : NO_VOICES;
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState(
    cached?.credential?.voiceId || (cached?.credential ? (cached.voices[0]?.id ?? "") : ""),
  );
  const [speechModel, setSpeechModel] = useState(cached?.credential?.speechModel ?? "");
  const [baseUrl, setBaseUrl] = useState(cached?.credential?.endpoint ?? "");
  const [ttsModel, setTtsModel] = useState(cached?.credential?.ttsModel ?? "");
  const [sttModel, setSttModel] = useState(cached?.credential?.sttModel ?? "");
  // The connection fields as last rendered, read when a connect finishes.
  const connection = useRef({ speechModel, baseUrl, ttsModel, sttModel });
  connection.current = { speechModel, baseUrl, ttsModel, sttModel };
  const speechModelSave = useRef<string | null>(null);
  const voicesRequest = useRef(0);
  const [loading, setLoading] = useState(!cached);
  const [pending, setPending] = useState<"connect" | "disconnect" | "voice" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy = pending !== null;

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  function markPending(next: "connect" | "disconnect" | "voice" | "test" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  /**
   * Fill the form from the provider's saved credential; voices load without blocking the form.
   * A background refresh of the provider already on screen keeps only the fields the user has
   * edited; the rest follow the saved settings, which may have changed elsewhere.
   */
  function showProvider(
    nextProvider: string,
    nextCredentials: VoiceCredential[],
    keepForm = false,
  ) {
    const request = ++voicesRequest.current;
    const cred = nextCredentials.find((entry) => entry.provider === nextProvider);
    const activeVoice = cred?.voiceId ?? "";
    const keep = (field: EditableField) => keepForm && edited.current.has(field);
    if (!keepForm) {
      edited.current.clear();
      providerRef.current = nextProvider;
      setProvider(nextProvider);
      setVoiceList({ provider: nextProvider, voices: [] });
    }
    if (!keep("voiceId")) setVoiceId(activeVoice);
    if (!keep("speechModel")) setSpeechModel(cred?.speechModel ?? "");
    if (!keep("baseUrl")) setBaseUrl(cred?.endpoint ?? "");
    if (!keep("ttsModel")) setTtsModel(cred?.ttsModel ?? "");
    if (!keep("sttModel")) setSttModel(cred?.sttModel ?? "");
    if (!cred) return Promise.resolve();
    return queryClient
      .fetchQuery(
        queries.voice.voices.queryOptions({
          input: { provider: nextProvider, scope },
          staleTime: 0,
        }),
      )
      .then(
        (listed) => {
          if (request !== voicesRequest.current) return;
          setVoiceList({ provider: nextProvider, voices: listed });
          if (!keep("voiceId") && !activeVoice && listed[0]) setVoiceId(listed[0].id);
        },
        (err: unknown) => {
          if (request === voicesRequest.current) throw err;
        },
      );
  }

  /** After a change (every call but the one on open) it never reuses a read sent before it. */
  async function refresh(nextProvider?: string, { keepForm = false, reuse = false } = {}) {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      fetchFresh(queryClient, queries.voice.catalog.queryOptions(), { reuse }),
      fetchFresh(queryClient, queries.voice.credentials.queryOptions(scoped), { reuse }),
      fetchFresh(queryClient, queries.voice.status.queryOptions(scoped), { reuse }),
    ]);
    const current = providerRef.current;
    const selected = selectedProvider(nextCatalog, [nextProvider, current, nextStatus.provider]);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    await showProvider(selected, nextCredentials, keepForm && selected === current);
  }

  async function chooseProvider(nextProvider: string) {
    setApiKey("");
    setError(null);
    setNotice(null);
    const cred = credentials.find((entry) => entry.provider === nextProvider);
    if (
      catalog.find((entry) => entry.id === nextProvider)?.keyless &&
      cred?.voiceId &&
      status?.provider !== nextProvider
    ) {
      markPending("voice");
      try {
        const saved = await rpc.voice.setVoice({
          scope,
          voiceId: cred.voiceId,
          provider: nextProvider,
        });
        setStatus(saved);
        queryClient.setQueryData(queries.voice.status.queryKey(scoped), saved);
      } catch (err) {
        setError(errorText(err, t`Could not save that voice`));
        return;
      } finally {
        markPending(null);
      }
    }
    await showProvider(nextProvider, credentials).catch((err: unknown) =>
      setError(errorText(err, t`Could not load voice settings`)),
    );
  }

  useEffect(() => {
    void refresh(undefined, { keepForm: Boolean(cached), reuse: true })
      .catch((err: unknown) => setError(errorText(err, t`Could not load voice settings`)))
      .finally(() => setLoading(false));
  }, []);

  const selected = catalog.find((entry) => entry.id === provider) ?? catalog[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const hiddenSelfHosted =
    !catalog.some((entry) => entry.id === OPENAI_COMPATIBLE_PROVIDER_ID) &&
    credentials.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID);
  const voiceOptions = useMemo(
    () => (voices.length ? voices : voiceId ? [{ id: voiceId, label: voiceId }] : []),
    [voices, voiceId],
  );

  const selfHosted = selected?.id === OPENAI_COMPATIBLE_PROVIDER_ID;
  // Connections are managed from the account; a Space can still connect one it lacks.
  const managesConnection = scope === "account" || !credential;
  const keyless = Boolean(selected?.keyless);
  const { keyOptional, linked, canConnect } = voiceConnectionForm({
    entry: selected,
    credential,
    apiKey,
    baseUrl,
  });

  async function connectKey() {
    if (!selected || !canConnect) return;
    setError(null);
    setNotice(null);
    // What this connect carries; anything typed after this point was not saved.
    const sentApiKey = apiKey;
    const sent = connection.current;
    markPending("connect");
    try {
      let connected: VoiceCredential;
      try {
        connected = await rpc.voice.connect({
          scope,
          provider: selected.id,
          apiKey: sentApiKey.trim(),
          // The server drops this voice when the address or speech model really changed.
          voiceId: voiceId || undefined,
          ...(selected.speechModel ? { speechModel: speechModel.trim() } : {}),
          ...(selfHosted
            ? {
                baseUrl: baseUrl.trim(),
                ttsModel: ttsModel.trim() || undefined,
                sttModel: sttModel.trim() || undefined,
              }
            : {}),
        });
      } catch (err) {
        setError(errorText(err, t`Could not connect this voice provider`));
        return;
      }
      // A key typed while the connect ran was not saved; keep it for the next try.
      setApiKey((current) => (current === sentApiKey ? "" : current));
      // The connect saved the voice the server kept for these values, and the
      // disabled field cannot hold a newer edit, so the voice follows the saved one.
      edited.current.delete("voiceId");
      // The connect saved the values it carried, which the server may have normalized or
      // filled in; fields typed meanwhile keep theirs.
      for (const field of CONNECTION_FIELDS) {
        if (connection.current[field] === sent[field]) edited.current.delete(field);
      }
      setNotice(t`Connected ${selected.name}.`);
      // The saved connection (the server may have picked another voice for a new address) shows
      // at once in untouched fields, so a failed read after it cannot leave stale values to send.
      const nextCredentials = credentials.some((entry) => entry.provider === connected.provider)
        ? credentials.map((entry) => (entry.provider === connected.provider ? connected : entry))
        : [...credentials, connected];
      setCredentials(nextCredentials);
      queryClient.setQueryData(queries.voice.credentials.queryKey(scoped), nextCredentials);
      void showProvider(selected.id, nextCredentials, true).catch(() => undefined);
      // The connect is saved; a failed read after it only leaves the form behind.
      await refresh(selected.id, { keepForm: true }).catch((err: unknown) =>
        setError(errorText(err, t`Could not load voice settings`)),
      );
    } finally {
      markPending(null);
    }
  }

  async function disconnectProvider(providerId = credential?.provider) {
    if (!providerId) return;
    setError(null);
    setNotice(null);
    markPending("disconnect");
    try {
      try {
        await rpc.voice.disconnect({ provider: providerId });
      } catch (err) {
        setError(errorText(err, t`Could not disconnect this voice provider`));
        return;
      }
      setApiKey("");
      if (providerId === providerRef.current) setVoiceId("");
      const drop = (current: VoiceCredential[]) =>
        current.filter((entry) => entry.provider !== providerId);
      setCredentials(drop);
      queryClient.setQueryData(queries.voice.credentials.queryKey(scoped), (current) =>
        current ? drop(current) : current,
      );
      await refresh(providerId).catch((err: unknown) =>
        setError(errorText(err, t`Could not load voice settings`)),
      );
    } finally {
      markPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    edited.current.add("voiceId");
    setVoiceId(nextVoiceId);
    if (!credential) return;
    markPending("voice");
    setError(null);
    try {
      try {
        await rpc.voice.setVoice({ scope, voiceId: nextVoiceId, provider: selected?.id });
      } catch (err) {
        setError(errorText(err, t`Could not save that voice`));
        return;
      }
      // The voice is saved; a failed read after it only leaves the form behind.
      await refresh(selected?.id, { keepForm: true }).catch((err: unknown) =>
        setError(errorText(err, t`Could not load voice settings`)),
      );
    } finally {
      markPending(null);
    }
  }

  async function saveSpeechModel() {
    if (!credential || !selected?.speechModel) return;
    const next = speechModel.trim();
    if (next === credential.speechModel) return;
    if (speechModelSave.current === next) return;
    speechModelSave.current = next;
    setError(null);
    markPending("voice");
    try {
      const saved = await rpc.voice.setSpeechModel({
        scope,
        provider: selected.id,
        speechModel: next,
      });
      setSpeechModel(saved.speechModel);
      const update = (current: VoiceCredential[]) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry));
      setCredentials(update);
      queryClient.setQueryData(queries.voice.credentials.queryKey(scoped), (current) =>
        current ? update(current) : current,
      );
    } catch (err) {
      setError(errorText(err, t`Could not save that speech model`));
    } finally {
      speechModelSave.current = null;
      markPending(null);
    }
  }

  async function testVoice() {
    // The sample uses the call's speaker, so it would cut off the reply.
    if (call) return;
    setError(null);
    setNotice(null);
    markPending("test");
    try {
      await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`, {
        spaceId,
        scope,
      });
      if (speaker.state.error) {
        setError(speaker.state.error);
        return;
      }
      setNotice(t`If you heard that, voice is ready.`);
    } catch (err) {
      setError(errorText(err, t`Could not play a test clip`));
    } finally {
      markPending(null);
    }
  }

  const content = (
    <>
      {loading && !catalog.length ? (
        <div className="grid place-items-center py-10">
          <Spinner
            className="size-5 text-muted-foreground"
            aria-label={t`Loading voice providers…`}
          />
        </div>
      ) : null}
      {error ? <p className="mb-4 text-body text-destructive">{error}</p> : null}
      {notice ? <p className="mb-4 text-body text-success">{notice}</p> : null}
      {catalog.length ? (
        <Field>
          <FieldLabel htmlFor={providerSelectId}>
            <Trans>Provider</Trans>
          </FieldLabel>
          <NativeSelect
            id={providerSelectId}
            className="w-full"
            value={provider}
            disabled={busy}
            onChange={(event) => void chooseProvider(event.target.value)}
          >
            {catalog.map((entry) => {
              const connected = credentials.some((cred) => cred.provider === entry.id);
              return (
                <NativeSelectOption key={entry.id} value={entry.id}>
                  {entry.name}
                  {connected ? ` (${t`Connected`})` : ""}
                </NativeSelectOption>
              );
            })}
          </NativeSelect>
        </Field>
      ) : null}
      {hiddenSelfHosted && scope === "account" ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void disconnectProvider(OPENAI_COMPATIBLE_PROVIDER_ID)}
        >
          <Trans>Disconnect Self-hosted</Trans>
        </Button>
      ) : null}
      {selected ? (
        <>
          {managesConnection ? (
            <>
              {selfHosted ? (
                <Field className="mt-5">
                  <FieldLabel htmlFor={baseUrlId}>
                    <Trans>Server URL</Trans>
                  </FieldLabel>
                  <Input
                    id={baseUrlId}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={baseUrl}
                    onChange={(event) => {
                      edited.current.add("baseUrl");
                      setBaseUrl(event.target.value);
                    }}
                    placeholder="http://192.168.1.10:8880/v1"
                  />
                </Field>
              ) : null}
              {keyless || linked ? null : (
                <Field className="mt-5">
                  <FieldLabel htmlFor={apiKeyId}>
                    <Trans>API key</Trans>
                  </FieldLabel>
                  <Input
                    id={apiKeyId}
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      selfHosted || keyOptional
                        ? t`Optional`
                        : credential
                          ? t`Paste a replacement key`
                          : t`Paste your API key`
                    }
                  />
                </Field>
              )}
              {selfHosted ? (
                <>
                  <Field className="mt-5">
                    <FieldLabel htmlFor={ttsModelId}>
                      <Trans>Speech model</Trans>
                    </FieldLabel>
                    <Input
                      id={ttsModelId}
                      autoComplete="off"
                      spellCheck={false}
                      value={ttsModel}
                      maxLength={200}
                      onChange={(event) => {
                        edited.current.add("ttsModel");
                        setTtsModel(event.target.value);
                      }}
                      placeholder={DEFAULT_COMPATIBLE_TTS_MODEL}
                    />
                  </Field>
                  <Field className="mt-5">
                    <FieldLabel htmlFor={sttModelId}>
                      <Trans>Transcription model</Trans>
                    </FieldLabel>
                    <Input
                      id={sttModelId}
                      autoComplete="off"
                      spellCheck={false}
                      value={sttModel}
                      maxLength={200}
                      onChange={(event) => {
                        edited.current.add("sttModel");
                        setSttModel(event.target.value);
                      }}
                      placeholder={DEFAULT_COMPATIBLE_STT_MODEL}
                    />
                  </Field>
                </>
              ) : null}
              {(keyless && credential) || linked ? null : (
                <Button
                  type="button"
                  className="mt-3"
                  disabled={busy || !canConnect}
                  onClick={() => void connectKey()}
                >
                  {/* A keyless option has nothing to connect; choosing it turns voice on. */}
                  {pending === "connect" ? (
                    <Trans>Connecting…</Trans>
                  ) : keyless ? (
                    <Trans>Turn on</Trans>
                  ) : credential && selfHosted ? (
                    <Trans>Reconnect</Trans>
                  ) : credential ? (
                    <Trans>Replace key</Trans>
                  ) : (
                    <Trans>Connect</Trans>
                  )}
                </Button>
              )}
              {credential ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => void disconnectProvider()}
                >
                  {pending === "disconnect" ? (
                    <Trans>Disconnecting…</Trans>
                  ) : keyless ? (
                    <Trans>Turn off</Trans>
                  ) : (
                    <Trans>Disconnect</Trans>
                  )}
                </Button>
              ) : null}
            </>
          ) : null}

          {credential ? (
            <>
              <Field className="mt-6">
                <FieldLabel htmlFor={voiceSelectId}>
                  <Trans>Voice</Trans>
                </FieldLabel>
                {selfHosted ? (
                  <>
                    <Input
                      id={voiceSelectId}
                      list={`${voiceSelectId}-list`}
                      className="w-full"
                      value={voiceId}
                      disabled={busy}
                      onChange={(event) => {
                        edited.current.add("voiceId");
                        setVoiceId(event.target.value);
                      }}
                      onBlur={() => {
                        const next = voiceId.trim();
                        if (next && next !== credential?.voiceId) void chooseVoice(next);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        event.currentTarget.blur();
                      }}
                    />
                    <datalist id={`${voiceSelectId}-list`}>
                      {voiceOptions.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                          {voice.description ? ` (${voice.description})` : ""}
                        </option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <NativeSelect
                    id={voiceSelectId}
                    className="w-full"
                    value={voiceId}
                    disabled={busy}
                    onChange={(event) => void chooseVoice(event.target.value)}
                  >
                    {voiceOptions.map((voice) => (
                      <NativeSelectOption key={voice.id} value={voice.id}>
                        {voice.label}
                        {voice.description ? ` (${voice.description})` : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              {selected.speechModel ? (
                <Field className="mt-6">
                  <FieldLabel htmlFor={speechModelId}>
                    <Trans>Speech model</Trans>
                  </FieldLabel>
                  <Input
                    id={speechModelId}
                    value={speechModel}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    placeholder={t`Optional`}
                    onChange={(event) => {
                      edited.current.add("speechModel");
                      setSpeechModel(event.target.value);
                    }}
                    onBlur={() => void saveSpeechModel()}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      event.currentTarget.blur();
                    }}
                  />
                </Field>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="mt-4"
                disabled={busy || !status?.ready || call !== null}
                onClick={() => void testVoice()}
              >
                {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );

  if (embedded) {
    return <div data-testid="voice-settings">{content}</div>;
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        data-testid="voice-settings"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[min(680px,calc(100%-2rem))] w-[920px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[min(680px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <DialogTitle className="text-heading2 font-medium text-foreground">
            <Trans>Voice</Trans>
          </DialogTitle>
          <DialogClose
            aria-label={t`Close voice settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="max-w-xl">{content}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function selectedProvider(
  catalog: VoiceCatalogEntry[],
  preferred: Array<string | null | undefined>,
): string {
  return preferred.find((id) => catalog.some((entry) => entry.id === id)) ?? catalog[0]?.id ?? "";
}

const NO_VOICES: VoiceInfo[] = [];

const CONNECTION_FIELDS = ["speechModel", "baseUrl", "ttsModel", "sttModel"] as const;

type EditableField = "voiceId" | (typeof CONNECTION_FIELDS)[number];
