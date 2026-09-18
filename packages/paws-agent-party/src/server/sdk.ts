import {
  BrowserCredentialProvider,
  PawsAgentClient,
  restorePawsCredentialsWithSecret,
  startBrowserAccountLink,
  type AgentRequest,
  type ImageAttachmentInput,
  type KeyValueStorage,
  type Machine,
  type BrowseDirectoryResult,
  type SessionConfiguration,
  type MessagePage,
  type MessageSubscription,
  type MessageWatchOptions,
  type SendMessageInput,
  type SendMessageReceipt,
  type Session,
  type SpawnSessionInput,
  type SpawnSessionResult,
  type PawsAgentEvent,
} from '@wangjs-jacky/paws-agent/browser';
import type { ConnectionStatus } from '../contracts.js';

export interface PawsSdkBoundary {
  subscribeText?(listener: (event: Extract<PawsAgentEvent, { type: 'text-delta' }>) => void): () => void;
  status(): ConnectionStatus;
  link(serverUrl: string): Promise<ConnectionStatus>;
  recover(serverUrl: string, recoveryCode: string): Promise<ConnectionStatus>;
  disconnect(): Promise<void>;
  machines(): Promise<Machine[]>;
  browseDirectory(machineId: string, path?: string): Promise<BrowseDirectoryResult>;
  configuration(machineId: string, sessionId?: string): Promise<{ available: false; reason: string } | ({ available: true; sessionId: string } & SessionConfiguration)>;
  spawn(input: SpawnSessionInput & { role: string }): Promise<SpawnSessionResult>;
  watch(sessionId: string, options: MessageWatchOptions): Promise<MessageSubscription>;
  send(input: SendMessageInput): Promise<SendMessageReceipt>;
  historyPage(sessionId: string, options: { afterSeq: number; limit: number; signal?: AbortSignal }): Promise<MessagePage>;
  session(sessionId: string): Promise<Session>;
  requests(sessionId: string): Promise<AgentRequest[]>;
  dispose(): Promise<void>;
}

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  get(key: string): Promise<string | null> { return Promise.resolve(this.values.get(key) ?? null); }
  set(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  remove(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

export function createRealPawsSdk(): PawsSdkBoundary {
  const storage = new MemoryStorage();
  let state: ConnectionStatus = { state: 'disconnected' };
  let provider: BrowserCredentialProvider | null = null;
  let client: PawsAgentClient | null = null;
  let pendingClient: PawsAgentClient | null = null;
  let linkController: AbortController | null = null;
  let generation = 0;

  const readyClient = (): PawsAgentClient => {
    if (!client || state.state !== 'ready') throw new Error('Link a Paws account before starting a consultation.');
    return client;
  };

  const disconnect = async (invalidate = true): Promise<void> => {
    if (invalidate) generation += 1;
    const previousController = linkController;
    const previousClient = client;
    const previousPendingClient = pendingClient;
    const previousProvider = provider;
    linkController = null;
    client = null;
    pendingClient = null;
    provider = null;
    state = { state: 'disconnected' };
    previousController?.abort(new DOMException('Account link cancelled', 'AbortError'));
    const cleanup: Promise<void>[] = [];
    if (previousClient) cleanup.push(previousClient.dispose());
    if (previousPendingClient && previousPendingClient !== previousClient) cleanup.push(previousPendingClient.dispose());
    if (previousProvider) cleanup.push(previousProvider.clearCredentials());
    await Promise.allSettled(cleanup);
  };

  return {
    status: () => ({ ...state }),
    async link(rawServerUrl) {
      const serverUrl = normalizeServerUrl(rawServerUrl);
      const operation = ++generation;
      await disconnect(false);
      if (generation !== operation) return { ...state };
      const controller = new AbortController();
      linkController = controller;
      const nextProvider = new BrowserCredentialProvider(storage, `paws-agent-party:${serverUrl}`);
      provider = nextProvider;
      const ownsOperation = () => generation === operation && linkController === controller;
      state = { state: 'connecting', serverUrl };
      try {
        const link = await startBrowserAccountLink({ serverUrl, credentials: nextProvider, signal: controller.signal });
        if (!ownsOperation()) return { ...state };
        state = { state: 'linking', serverUrl, qrUrl: link.qrUrl };
        void link.waitForAuthorization({ signal: controller.signal }).then(async () => {
          if (controller.signal.aborted || !ownsOperation()) return;
          state = { state: 'connecting', serverUrl };
          const candidate = new PawsAgentClient({ serverUrl, credentials: nextProvider });
          pendingClient = candidate;
          try {
            await candidate.connect();
            await candidate.machines.list({ active: true });
            if (controller.signal.aborted || !ownsOperation()) return;
            client = candidate;
            pendingClient = null;
            linkController = null;
            state = { state: 'ready', serverUrl };
          } finally {
            if (pendingClient === candidate) pendingClient = null;
            if (client !== candidate) await candidate.dispose().catch(() => undefined);
          }
        }).catch(async error => {
          if (!ownsOperation() || controller.signal.aborted) return;
          await nextProvider.clearCredentials().catch(() => undefined);
          if (!ownsOperation()) return;
          linkController = null;
          provider = null;
          state = { state: 'error', serverUrl, error: safeError(error) };
        });
        return { ...state };
      } catch (error) {
        if (!ownsOperation()) return { ...state };
        await nextProvider.clearCredentials().catch(() => undefined);
        if (!ownsOperation()) return { ...state };
        linkController = null;
        provider = null;
        state = { state: 'error', serverUrl, error: safeError(error) };
        return { ...state };
      }
    },
    async recover(rawServerUrl, recoveryCode) {
      const serverUrl = normalizeServerUrl(rawServerUrl);
      const recoverySecret = decodeRecoveryCode(recoveryCode);
      const operation = ++generation;
      await disconnect(false);
      if (generation !== operation) { recoverySecret.fill(0); return { ...state }; }
      const controller = new AbortController();
      linkController = controller;
      const nextProvider = new BrowserCredentialProvider(storage, `paws-agent-party:${serverUrl}`);
      provider = nextProvider;
      const ownsOperation = () => generation === operation && linkController === controller;
      state = { state: 'connecting', serverUrl };
      try {
        const credentials = await restorePawsCredentialsWithSecret({ serverUrl, secret: recoverySecret, signal: controller.signal });
        recoverySecret.fill(0);
        if (!ownsOperation()) return { ...state };
        await nextProvider.setCredentials(credentials);
        const candidate = new PawsAgentClient({ serverUrl, credentials: nextProvider });
        pendingClient = candidate;
        try {
          await candidate.connect();
          await candidate.machines.list({ active: true });
          if (controller.signal.aborted || !ownsOperation()) return { ...state };
          client = candidate;
          pendingClient = null;
          linkController = null;
          state = { state: 'ready', serverUrl };
          return { ...state };
        } finally {
          if (pendingClient === candidate) pendingClient = null;
          if (client !== candidate) await candidate.dispose().catch(() => undefined);
        }
      } catch (error) {
        recoverySecret.fill(0);
        if (!ownsOperation()) return { ...state };
        await nextProvider.clearCredentials().catch(() => undefined);
        if (!ownsOperation()) return { ...state };
        linkController = null;
        provider = null;
        state = { state: 'error', serverUrl, error: safeError(error) };
        return { ...state };
      }
    },
    disconnect,
    subscribeText: listener => readyClient().subscribe(event => { if (event.type === 'text-delta') listener(event); }),
    machines: () => readyClient().machines.list({ active: true }),
    browseDirectory: (machineId, path) => readyClient().machines.browseDirectory({ machineId, path }),
    async configuration(machineId, sessionId) {
      if (!sessionId) return { available: false, reason: 'The Paws SDK exposes model configuration only for an existing session; provide sessionId from this machine.' };
      const session = await readyClient().sessions.get(sessionId);
      const metadata = session.metadata && typeof session.metadata === 'object' ? session.metadata as Record<string, unknown> : {};
      if (metadata.machineId !== machineId) throw new Error('The session does not belong to the requested machine.');
      return { available: true, sessionId, ...await readyClient().sessions.getConfiguration(sessionId) };
    },
    spawn: ({ role: _role, ...input }) => readyClient().sessions.spawn(input),
    watch: (sessionId, options) => readyClient().messages.watch(sessionId, options),
    send: input => readyClient().messages.send(input),
    historyPage: (sessionId, options) => readyClient().messages.historyPage(sessionId, options),
    session: sessionId => readyClient().sessions.get(sessionId),
    async requests(sessionId) {
      const session = await readyClient().sessions.get(sessionId);
      const requests = (session.agentState as { requests?: Record<string, unknown> } | null)?.requests ?? {};
      return Object.entries(requests).map(([id, payload]) => {
        const type = payload && typeof payload === 'object' && 'type' in payload && typeof payload.type === 'string'
          ? payload.type : 'permission';
        return { id, type, payload };
      });
    },
    dispose: disconnect,
  };
}

export type LoadedImage = { name: string; mimeType: string; bytes: Uint8Array } & Pick<ImageAttachmentInput, 'width' | 'height'>;

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Paws operation failed.';
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|secret|key)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function normalizeServerUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Enter a valid Paws server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Paws server URL must use HTTP or HTTPS without embedded credentials.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function decodeRecoveryCode(value: string): Uint8Array {
  const normalized = value.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G').replace(/[^A-Z2-7]/g, '');
  if (normalized.length !== 52) throw new Error('Enter a valid 52-character Paws recovery code.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = []; let buffer = 0; let bits = 0;
  for (const char of normalized) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Enter a valid Paws recovery code.');
    buffer = (buffer << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  if (bytes.length !== 32) throw new Error('Enter a valid Paws recovery code.');
  return new Uint8Array(bytes);
}
