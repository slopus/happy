import { ORPCError } from "@orpc/server";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import {
  createVoiceProvider,
  isModelConnectionVoiceSecret,
  isSpeechModelId,
  isVoiceProviderId,
  listVoiceCatalog,
  MAX_SPEAK_CHARS,
  MAX_TRANSCRIBE_BYTES,
  MODEL_CONNECTION_VOICE_SECRET,
  NoVoiceConfigured,
  OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
  openAiCompatibleVoiceServer,
  resolveVoiceKey,
  serializeOpenAiCompatibleVoiceSecret,
  voiceCatalogEntry,
} from "@rakazo/adapters";
import type {
  Actor,
  SettingsScope,
  VoiceAccountErrorCode,
  VoiceCredential,
  VoiceStatus,
} from "@rakazo/contracts";
import { SettingsScopeSchema } from "@rakazo/contracts";
import { speakable, toUtterances } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  deleteUnreferencedCredentialSecret,
  findDefaultVoiceCredential,
  findModelCredential,
  findVoiceCredential,
  findVoicePreference,
  IsolationError,
  lockSpaceSettings,
  newestVoiceCredentialOrder,
  Prisma,
  runAsSystemInTransaction,
  runAsTenant,
  saveVoicePreference,
  selectVoicePreference,
  voicePreferenceTarget,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import type { SpeechSummarizer } from "./speech-summary.js";

export interface VoiceDeps {
  prisma: PrismaClient;
  secrets: SecretStore;
  /** The instance flag (`MCP_ALLOW_PRIVATE_ENDPOINT`). */
  env?: { mcpAllowPrivateEndpoint?: boolean };
  /** Set only when `VOICE_SUMMARY_MIN_CHARS` turns spoken summaries on. */
  speechSummary?: { summarize: SpeechSummarizer; minChars: number };
}

/** A self-hosted speech server on a private address is limited like model endpoints. */
async function voiceMayUsePrivateEndpoint(deps: VoiceDeps, provider: string) {
  return (
    provider === OPENAI_COMPATIBLE_VOICE_PROVIDER_ID && deps.env?.mcpAllowPrivateEndpoint === true
  );
}

/** The voice adapter for a credential, with the caller's private-endpoint decision. */
export async function voiceProviderFor(deps: VoiceDeps, provider: string) {
  return createVoiceProvider(provider, {
    allowPrivateEndpoint: await voiceMayUsePrivateEndpoint(deps, provider),
  });
}

/** The catalog as this account sees it: `modelConnection` stays only where it has one. */
export async function accountVoiceCatalog(deps: VoiceDeps, actor: Pick<Actor, "userId">) {
  const catalog = listVoiceCatalog({ allowPrivateEndpoint: deps.env?.mcpAllowPrivateEndpoint });
  return Promise.all(
    catalog.map(async ({ modelConnection, ...entry }) =>
      modelConnection && (await findModelCredential(deps.prisma, actor, entry.id))
        ? { ...entry, modelConnection }
        : entry,
    ),
  );
}

const SPEAK_TIMEOUT_MS = 60_000;
export const MAX_SPEAK_REQUEST_BYTES = 16 * 1024;
export const MAX_TRANSCRIBE_REQUEST_BYTES = 4 * Math.ceil(MAX_TRANSCRIBE_BYTES / 3) + 1024;

export function voiceContext(
  actor: Pick<Actor, "userId" | "spaceId">,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId: "voice",
    traceId: "voice",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export function catalogEntry(provider: string) {
  return voiceCatalogEntry(provider);
}

export function toVoiceStatus(cred: { provider: string; voiceId: string } | null): VoiceStatus {
  const entry = cred ? catalogEntry(cred.provider) : undefined;
  return {
    configured: Boolean(cred),
    ready: Boolean(cred?.voiceId),
    transcribe: Boolean(entry?.transcribe && cred),
    provider: cred?.provider ?? null,
    voiceId: cred?.voiceId ?? "",
  };
}

export function toVoiceCredential(row: {
  id: string;
  provider: string;
  isDefault: boolean;
  voiceId: string;
  speechModel?: string | null;
  server?: { endpoint: string; ttsModel: string; sttModel: string };
  /** False when the connection uses the account's model connection instead of a key. */
  hasKey?: boolean;
}): VoiceCredential {
  return {
    id: row.id,
    provider: row.provider,
    hasKey: row.hasKey ?? true,
    isDefault: row.isDefault,
    voiceId: row.voiceId,
    speechModel: row.speechModel ?? "",
    transcribe: Boolean(catalogEntry(row.provider)?.transcribe),
    endpoint: row.server?.endpoint ?? "",
    ttsModel: row.server?.ttsModel ?? "",
    sttModel: row.server?.sttModel ?? "",
  };
}

/**
 * A self-hosted connection's address and model ids, read from its secret. Undefined for
 * hosted providers and for a secret that cannot be read, which still lists the connection.
 */
export async function voiceCredentialServer(
  deps: VoiceDeps,
  actor: Actor,
  row: { provider: string; secretId: string },
) {
  if (row.provider !== OPENAI_COMPATIBLE_VOICE_PROVIDER_ID) return undefined;
  try {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: row.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret) return undefined;
    return openAiCompatibleVoiceServer(await deps.secrets.load(secret.ciphertext, secret.id));
  } catch {
    // Reconnecting replaces an unreadable secret.
    return undefined;
  }
}

/**
 * Whether a connection stores its own key. Only a provider that can use the account's model
 * connection opens its secret to tell; one that cannot be read counts as a key.
 */
export async function voiceCredentialHasKey(
  deps: VoiceDeps,
  actor: Pick<Actor, "userId">,
  row: { provider: string; secretId: string },
) {
  if (!voiceCatalogEntry(row.provider)?.modelConnection) return true;
  try {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: row.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret) return true;
    return !isModelConnectionVoiceSecret(await deps.secrets.load(secret.ciphertext, secret.id));
  } catch {
    return true;
  }
}

/**
 * Another server or speech model has its own voices, so saved voice choices cannot carry
 * over. Only self-hosted connections can change either while keeping the credential.
 */
export function voiceChoicesChanged(previousPlaintext: string | undefined, plaintext: string) {
  const previous = previousPlaintext ? openAiCompatibleVoiceServer(previousPlaintext) : undefined;
  if (!previous) return false;
  const next = openAiCompatibleVoiceServer(plaintext);
  return previous.endpoint !== next?.endpoint || previous.ttsModel !== next?.ttsModel;
}

/**
 * The secret to store. Hosted providers keep the bare key, or a marker to use the account's
 * model connection when the provider can and no key was given; a self-hosted server stores
 * its base URL, optional key, and model ids, validated like model connections.
 */
export function voiceCredentialPlaintext(input: {
  provider: string;
  plaintext: string;
  baseUrl?: string;
  ttsModel?: string;
  sttModel?: string;
  /** The stored secret for this provider; blank fields keep its key and models. */
  previousPlaintext?: string;
  allowPrivateEndpoint?: boolean;
}): string {
  if (voiceCatalogEntry(input.provider)?.keyless) {
    // The credential row is what selects the provider; it has no key to keep.
    return input.provider;
  }
  if (input.provider !== OPENAI_COMPATIBLE_VOICE_PROVIDER_ID) {
    const key = input.plaintext.trim();
    if (!key && voiceCatalogEntry(input.provider)?.modelConnection) {
      return MODEL_CONNECTION_VOICE_SECRET;
    }
    if (key.length < 8) {
      throw new ORPCError("BAD_REQUEST", { message: "Enter an API key." });
    }
    return input.plaintext;
  }
  try {
    return serializeOpenAiCompatibleVoiceSecret(
      {
        baseUrl: input.baseUrl ?? "",
        apiKey: input.plaintext,
        ttsModel: input.ttsModel,
        sttModel: input.sttModel,
      },
      input.previousPlaintext,
      { allowPrivate: input.allowPrivateEndpoint },
    );
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "That server URL is not valid.",
    });
  }
}

/** Empty clears the speech model override. Anything else must be a header-safe model id. */
export function speechModelValue(speechModel: string): string | null {
  const trimmed = speechModel.trim();
  if (!trimmed) return null;
  if (!isSpeechModelId(trimmed)) {
    throw new ORPCError("BAD_REQUEST", { message: "That speech model id is not valid." });
  }
  return trimmed;
}

export async function loadDefaultVoiceCredential(
  deps: VoiceDeps,
  actor: Pick<Actor, "userId" | "spaceId">,
  scope?: SettingsScope,
  signal?: AbortSignal,
) {
  return loadVoiceCredential(deps, actor, undefined, scope, signal);
}

/** Keep refresh failures and linked-connection refusals safe for display. */
export async function withVoiceConnection<T>(
  provider: string,
  linked: boolean,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!linked) throw error;
    const name = voiceCatalogEntry(provider)?.name ?? provider;
    if (error instanceof VoiceAccountError) {
      if (error.code === "VOICE_KEY_REJECTED") {
        throw new VoiceAccountError(
          error.code,
          `${name} didn't accept the Models connection for voice. Disconnect and paste an API key.`,
        );
      }
      throw error;
    }
    getLogger().warn("voice could not use the model connection", {
      provider,
      reason: error instanceof Error ? error.name : "unknown",
    });
    throw new VoiceAccountError(
      undefined,
      `Couldn't use the ${name} connection from Models. Try again.`,
    );
  }
}

/** The connection and the bearer its provider takes, read from a model connection if linked. */
export async function loadVoiceCredential(
  deps: VoiceDeps,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider?: string,
  scope?: SettingsScope,
  signal?: AbortSignal,
) {
  const cred = provider
    ? await findVoiceCredential(deps.prisma, actor, provider, scope)
    : await findDefaultVoiceCredential(deps.prisma, actor, scope);
  if (!cred) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: cred.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) return null;
  const plaintext = await deps.secrets.load(secret.ciphertext, secret.id);
  const linked =
    isModelConnectionVoiceSecret(plaintext) &&
    Boolean(voiceCatalogEntry(cred.provider)?.modelConnection);
  const apiKey = await withVoiceConnection(cred.provider, linked, () =>
    resolveVoiceKey(
      { prisma: deps.prisma, secretStore: deps.secrets },
      { userId: actor.userId, spaceId: actor.spaceId },
      cred.provider,
      plaintext,
      signal,
    ),
  );
  return { cred, apiKey, linked };
}

export async function resolveVoiceTarget(
  deps: VoiceDeps,
  actor: Actor,
  input: { botId?: string; voiceId?: string; scope?: SettingsScope; signal?: AbortSignal },
) {
  let botVoiceId: string | null = null;
  if (input.botId) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId },
      select: { voiceId: true },
    });
    if (!bot) throw new IsolationError();
    botVoiceId = bot.voiceId;
  }
  const loaded = await loadDefaultVoiceCredential(deps, actor, input.scope, input.signal);
  if (!loaded) throw new NoVoiceConfigured("key");
  const voiceId = input.voiceId || botVoiceId || loaded.cred.voiceId;
  if (!voiceId) throw new NoVoiceConfigured("voice");
  return { ...loaded, voiceId };
}

export async function persistVoiceCredential(
  deps: VoiceDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    voiceId?: string;
    speechModel?: string;
    baseUrl?: string;
    ttsModel?: string;
    sttModel?: string;
    /** Which copy the connection becomes the default voice in; omitted is what applies. */
    scope?: SettingsScope;
    signal?: AbortSignal;
  },
): Promise<VoiceCredential> {
  if (!isVoiceProviderId(input.provider)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown voice provider." });
  }
  const previous =
    input.provider === OPENAI_COMPATIBLE_VOICE_PROVIDER_ID
      ? // An unreadable old secret only means nothing is inherited; the form must be complete.
        await loadVoiceCredential(deps, actor, input.provider).catch(() => null)
      : null;
  const allowPrivateEndpoint = await voiceMayUsePrivateEndpoint(deps, input.provider);
  const plaintext = voiceCredentialPlaintext({
    ...input,
    previousPlaintext: previous?.apiKey,
    allowPrivateEndpoint,
  });
  const server =
    input.provider === OPENAI_COMPATIBLE_VOICE_PROVIDER_ID
      ? openAiCompatibleVoiceServer(plaintext)
      : undefined;
  const choicesChanged = voiceChoicesChanged(previous?.apiKey, plaintext);
  const requestedSpeechModel =
    voiceCatalogEntry(input.provider)?.speechModel && input.speechModel !== undefined
      ? speechModelValue(input.speechModel)
      : undefined;
  const provider = createVoiceProvider(input.provider, { allowPrivateEndpoint });
  let apiKey: string;
  try {
    apiKey = await resolveVoiceKey(
      { prisma: deps.prisma, secretStore: deps.secrets },
      { userId: actor.userId, spaceId: actor.spaceId },
      input.provider,
      plaintext,
      input.signal,
    );
  } catch (error) {
    if (error instanceof VoiceAccountError) {
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    if (input.signal?.aborted) throw error;
    // A refresh that timed out or failed to reach the provider; its text can quote the provider.
    getLogger().warn("voice could not use the model connection", {
      provider: input.provider,
      reason: error instanceof Error ? error.name : "unknown",
    });
    throw new ORPCError("BAD_REQUEST", {
      message: `Couldn't use the ${voiceCatalogEntry(input.provider)?.name ?? input.provider} connection from Models. Try again.`,
    });
  }
  const verified = await provider.verify(apiKey, voiceContext(actor, input.signal));
  if (!verified.ok) {
    // No key was typed, so "check the key" would not help. Credit, rate limits and outages keep
    // the provider's own words.
    const refusedLink =
      isModelConnectionVoiceSecret(plaintext) && verified.code === "VOICE_KEY_REJECTED";
    throw new ORPCError("BAD_REQUEST", {
      message: refusedLink
        ? `${voiceCatalogEntry(input.provider)?.name ?? input.provider} didn't accept the Models connection for voice. Paste an API key.`
        : (verified.message ?? "That key was rejected."),
    });
  }
  let voiceId = choicesChanged ? "" : (input.voiceId?.trim() ?? "");
  let validVoiceIds: string[] = [];
  if (!voiceId) {
    const voices = await withVoiceConnection(
      input.provider,
      isModelConnectionVoiceSecret(plaintext),
      () => provider.listVoices(apiKey, voiceContext(actor, input.signal)),
    );
    voiceId = voices[0]?.id ?? "";
    validVoiceIds = voices.map((voice) => voice.id);
  }
  const stored = await deps.secrets.put(plaintext, voiceContext(actor, input.signal));
  const cred = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.userVoiceCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestVoiceCredentialOrder,
        });
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "voice",
            ciphertext: stored.ciphertext,
          },
        });
        const credential = !existing
          ? await tx.userVoiceCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                secretId: secret.id,
              },
            })
          : await tx.userVoiceCredential.update({
              where: { id: existing.id },
              data: { secretId: secret.id },
            });
        await lockSpaceSettings(tx, actor);
        const target = await voicePreferenceTarget(tx, actor, input.scope);
        const previousPreference = existing
          ? await findVoicePreference(tx, target, existing.id)
          : null;
        const selectedVoiceId =
          voiceId || (choicesChanged ? "" : previousPreference?.voiceId) || "";
        const speechModel =
          requestedSpeechModel !== undefined
            ? requestedSpeechModel
            : previousPreference?.speechModel;
        await selectVoicePreference(tx, target, credential.id, selectedVoiceId, speechModel);
        if (existing && choicesChanged) {
          // The credential is account-wide but the account and each Space that overrides
          // voice keep their own voice. Move every other copy whose voice the new server
          // or model lacks onto the new default.
          const stale = {
            userId: actor.userId,
            credentialId: existing.id,
            voiceId: { notIn: validVoiceIds },
          };
          if (target.scope === "space") {
            await tx.userVoicePreference.updateMany({
              where: stale,
              data: { voiceId: selectedVoiceId },
            });
          }
          await runAsSystemInTransaction(
            tx,
            "move a voice connection's other Spaces onto its new server",
            () =>
              tx.spaceVoicePreference.updateMany({
                where: {
                  ...stale,
                  spaceMember: { settingOverrides: { some: { setting: "voice" } } },
                  ...(target.scope === "space" ? { spaceId: { not: actor.spaceId } } : {}),
                },
                data: { voiceId: selectedVoiceId },
              }),
          );
        }
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "voice",
            credentialId: existing.id,
            secretId: existing.secretId,
          });
        }
        return {
          ...credential,
          isDefault: true,
          voiceId: selectedVoiceId,
          speechModel: speechModel ?? "",
          server,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return toVoiceCredential({ ...cred, hasKey: !isModelConnectionVoiceSecret(plaintext) });
}

export async function disconnectVoiceCredential(
  deps: VoiceDeps,
  actor: Actor,
  input: { provider: string },
): Promise<{ ok: true }> {
  const provider = input.provider.trim();
  if (!provider) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown voice provider." });
  }
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.userVoiceCredential.findMany({
          where: { userId: actor.userId, provider },
        });
        if (existing.length === 0) return;
        const ids = existing.map((row) => row.id);
        const removed = { userId: actor.userId, credentialId: { in: ids } };
        await tx.userVoicePreference.deleteMany({ where: removed });
        await tx.spaceVoicePreference.deleteMany({ where: removed });
        await tx.userVoiceCredential.deleteMany({
          where: { userId: actor.userId, id: { in: ids } },
        });
        for (const row of existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "voice",
            credentialId: row.id,
            secretId: row.secretId,
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ok: true as const };
}

export async function updateVoiceSpeechModel(
  deps: VoiceDeps,
  actor: Actor,
  input: { provider: string; speechModel: string; scope?: SettingsScope },
): Promise<VoiceCredential> {
  if (!voiceCatalogEntry(input.provider)?.speechModel) {
    throw new ORPCError("BAD_REQUEST", { message: "This voice provider has no speech model." });
  }
  const speechModel = speechModelValue(input.speechModel);
  return withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const found = await tx.userVoiceCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestVoiceCredentialOrder,
        });
        if (!found) {
          throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
        }
        await lockSpaceSettings(tx, actor);
        const target = await voicePreferenceTarget(tx, actor, input.scope);
        const preference = await findVoicePreference(tx, target, found.id);
        // Remember the model without taking the default. Another provider may already be
        // selected, and a new row still has no voice.
        if (!preference && speechModel === null) {
          return toVoiceCredential({ ...found, isDefault: false, voiceId: "", speechModel: "" });
        }
        const saved = await saveVoicePreference(tx, target, found.id, { speechModel });
        return toVoiceCredential({
          ...found,
          isDefault: saved.isDefault,
          voiceId: saved.voiceId,
          speechModel: saved.speechModel,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function prepareVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: {
    text: string;
    voiceId?: string;
    botId?: string;
    scope?: SettingsScope;
    signal?: AbortSignal;
  },
) {
  try {
    await resolveVoiceTarget(deps, actor, input);
  } catch (error) {
    if (error instanceof NoVoiceConfigured) {
      return { ready: false, utterances: [] as string[] };
    }
    throw error;
  }
  return { ready: true, utterances: await spokenUtterances(deps, actor, input) };
}

async function spokenUtterances(
  deps: VoiceDeps,
  actor: Actor,
  input: { text: string; botId?: string; signal?: AbortSignal },
): Promise<string[]> {
  const full = toUtterances(input.text);
  const summary = deps.speechSummary;
  if (!input.botId || !summary) return full;
  if (speakable(input.text).length <= summary.minChars) return full;
  const spoken = await summary.summarize(actor, input.botId, input.text, input.signal);
  const utterances = spoken ? toUtterances(spoken) : [];
  return utterances.length > 0 ? utterances : full;
}

export async function synthesizeVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: {
    text: string;
    voiceId?: string;
    botId?: string;
    scope?: SettingsScope;
    signal?: AbortSignal;
  },
) {
  const target = await resolveVoiceTarget(deps, actor, input);
  const text = input.text.trim();
  if (!text) throw new ORPCError("BAD_REQUEST", { message: "Nothing to speak." });
  if (text.length > MAX_SPEAK_CHARS) {
    throw new ORPCError("BAD_REQUEST", { message: "That utterance is too long to speak." });
  }
  const provider = await voiceProviderFor(deps, target.cred.provider);
  return withVoiceConnection(target.cred.provider, target.linked, () =>
    provider.synthesize(
      {
        text,
        voiceId: target.voiceId,
        apiKey: target.apiKey,
        model: target.cred.speechModel || undefined,
        signal: input.signal,
      },
      voiceContext(actor, input.signal),
    ),
  );
}

export async function transcribeVoice(
  deps: VoiceDeps,
  actor: Actor,
  input: { audio: Uint8Array; mimeType: string; language?: string; signal?: AbortSignal },
) {
  const loaded = await loadDefaultVoiceCredential(deps, actor, undefined, input.signal);
  if (!loaded) throw new NoVoiceConfigured("key");
  const provider = await voiceProviderFor(deps, loaded.cred.provider);
  if (!provider.transcribe) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This voice provider does not transcribe audio. Use on-device dictation instead.",
    });
  }
  if (input.audio.byteLength === 0 || input.audio.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new ORPCError("BAD_REQUEST", { message: "That recording is empty or too large." });
  }
  return withVoiceConnection(loaded.cred.provider, loaded.linked, () =>
    provider.transcribe!(
      {
        audio: input.audio,
        mimeType: input.mimeType || "audio/webm",
        language: input.language,
        apiKey: loaded.apiKey,
        signal: input.signal,
      },
      voiceContext(actor, input.signal),
    ),
  );
}

/**
 * Transcribes inbound messaging audio (for example a Telegram voice note) with
 * the bot owner's default voice connection, as the app's dictation does. Null
 * when no provider can transcribe or the audio is too large; the caller treats
 * a throw the same way, so the file is delivered without a transcript.
 */
export async function transcribeInboundVoice(
  deps: VoiceDeps,
  owner: Pick<Actor, "userId" | "spaceId">,
  input: { audio: Uint8Array; mimeType: string; signal?: AbortSignal },
): Promise<string | null> {
  if (input.audio.byteLength > MAX_TRANSCRIBE_BYTES) return null;
  const loaded = await loadDefaultVoiceCredential(deps, owner, undefined, input.signal);
  if (!loaded) return null;
  const provider = await voiceProviderFor(deps, loaded.cred.provider);
  if (!provider.transcribe) return null;
  const { text } = await withVoiceConnection(loaded.cred.provider, loaded.linked, () =>
    provider.transcribe!(
      { audio: input.audio, mimeType: input.mimeType, apiKey: loaded.apiKey },
      voiceContext(owner, input.signal),
    ),
  );
  return text;
}

export function mountVoiceHttpRoutes(
  app: Hono,
  deps: VoiceDeps,
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  app.post("/api/voice/speak", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_SPEAK_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseVoiceRequestBody(raw);
    try {
      const clip = await runAsTenant(actor, () =>
        synthesizeVoice(deps, actor, {
          text: String((body as { text?: unknown }).text ?? ""),
          voiceId: optionalString((body as { voiceId?: unknown }).voiceId),
          botId: optionalString((body as { botId?: unknown }).botId),
          scope: SettingsScopeSchema.safeParse((body as { scope?: unknown }).scope).data,
          signal: AbortSignal.any(
            [c.req.raw.signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)].filter(
              Boolean,
            ) as AbortSignal[],
          ),
        }),
      );
      // Copy into a fresh ArrayBuffer-backed view: DOM-lib BodyInit rejects
      // Uint8Array<ArrayBufferLike> since TS 5.7.
      return new Response(new Uint8Array(clip.bytes), {
        headers: {
          "content-type": clip.mimeType,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });

  app.post("/api/voice/transcribe", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_TRANSCRIBE_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const body = parseVoiceRequestBody(raw);
    const audioBase64 = String((body as { audioBase64?: unknown }).audioBase64 ?? "");
    const language = optionalString((body as { language?: unknown }).language);
    try {
      const audio = decodeAudioBase64(audioBase64);
      const result = await runAsTenant(actor, () =>
        transcribeVoice(deps, actor, {
          audio,
          mimeType: String((body as { mimeType?: unknown }).mimeType ?? "audio/webm"),
          language,
          signal: c.req.raw.signal,
        }),
      );
      return c.json({ text: result.text });
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });
}

function parseVoiceRequestBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeAudioBase64(value: string): Uint8Array {
  if (!value.trim()) throw new ORPCError("BAD_REQUEST", { message: "Recording is empty." });
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Recording is not valid audio." });
  }
}

/** Spent credit is 402; any other refusal is 403, never 401, which clients read as a lost session. */
export function voiceAccountErrorStatus(code: VoiceAccountErrorCode | undefined) {
  return code === "VOICE_OUT_OF_CREDIT" ? 402 : 403;
}

function voiceHttpError(c: Context, error: unknown) {
  if (error instanceof IsolationError) {
    return c.json({ error: "Resource not found" }, 404);
  }
  if (error instanceof NoVoiceConfigured) {
    return c.json({ error: error.message }, 409);
  }
  if (error instanceof ORPCError) {
    const code = String(error.code ?? "BAD_REQUEST");
    const status =
      code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    return c.json({ error: error.message }, status);
  }
  if (error instanceof VoiceAccountError) {
    getLogger().warn("voice provider account rejected the request", {
      route: c.req.path,
      reason: error.code ?? error.name,
    });
    return c.json({ error: error.message, code: error.code }, voiceAccountErrorStatus(error.code));
  }
  const message = "Voice request failed. Try again.";
  // Log only the error kind; provider response text can contain credentials.
  getLogger().warn("voice request failed", {
    route: c.req.path,
    reason: error instanceof Error ? error.name : "unknown",
  });
  if (isVoiceProviderFailure(error)) markExpectedFailure();
  return c.json({ error: message }, 502);
}

/** Voice adapters raise plain errors for provider refusals and setup problems; anything else is a bug. */
export function isVoiceProviderFailure(error: unknown) {
  return (
    error instanceof Error &&
    (Object.getPrototypeOf(error) === Error.prototype ||
      error.name === "AbortError" ||
      error.name === "TimeoutError")
  );
}
