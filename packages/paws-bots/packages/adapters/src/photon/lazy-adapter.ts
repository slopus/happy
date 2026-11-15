import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { getLogger } from "@rakazo/logging";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FormattedContent,
  Logger,
  WebhookOptions,
} from "chat";
import { stringifyMarkdown } from "chat";

export interface PhotonAdapterConfig {
  projectId: string;
  projectSecret: string;
  /** Per-webhook signing secret. When set, inbound arrives by webhook instead of the stream. */
  webhookSecret?: string | undefined;
  /** Consume Spectrum's inbound stream after initialize (the API process only). */
  pollInboundMessages: boolean;
}

/** The adapter's native thread ids: "imessage:<chatGuid>" plus "~<line>" when pinned. */
export interface PhotonThreadId {
  chatGuid: string;
  phone?: string;
}

const THREAD_PREFIX = "imessage:";
const LINE_SEP = "~";

/**
 * How often the stream listener is re-armed. The adapter's pump stops for good
 * when Spectrum's stream ends or errors; each re-arm restarts it if so and is a
 * no-op while it runs.
 */
export const PHOTON_LISTEN_WINDOW_MS = 60_000;

/**
 * Spectrum's stream has no acknowledgement to withhold, so a message whose
 * processing fails is never redelivered. Retry it here instead, like the
 * Telegram adapter's polling checkpoint; downstream client nonces make a
 * repeat that partly succeeded harmless.
 */
export const PHOTON_STREAM_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

// The adapter logs every stream re-arm at info; keep only its warnings and errors.
const photonLogger: Logger = {
  child: () => photonLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: (message, bindings) => getLogger().warn(`photon: ${message}`, logBindings(bindings)),
  error: (message, bindings) => getLogger().error(`photon: ${message}`, logBindings(bindings)),
};

function logBindings(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function encodePhotonThreadId({ chatGuid, phone }: PhotonThreadId): string {
  return phone ? `${THREAD_PREFIX}${chatGuid}${LINE_SEP}${phone}` : `${THREAD_PREFIX}${chatGuid}`;
}

export function decodePhotonThreadId(threadId: string): PhotonThreadId {
  if (!threadId.startsWith(THREAD_PREFIX)) {
    throw new Error(`Invalid iMessage thread ID: ${threadId}`);
  }
  const rest = threadId.slice(THREAD_PREFIX.length);
  const sep = rest.indexOf(LINE_SEP);
  const chatGuid = sep === -1 ? rest : rest.slice(0, sep);
  if (!chatGuid) throw new Error(`Invalid iMessage thread ID: ${threadId}`);
  return sep === -1 ? { chatGuid } : { chatGuid, phone: rest.slice(sep + 1) };
}

/**
 * Photon (Spectrum Cloud) iMessage through Photon's own Chat SDK adapter.
 * The adapter and spectrum-ts load only once used, so unconfigured processes
 * never pay for them. Inbound arrives over Spectrum's outbound gRPC stream,
 * so a server with no public HTTPS endpoint still receives messages; with a
 * webhook secret it uses Spectrum's signed webhook instead.
 */
export class LazyPhotonAdapter implements Adapter {
  readonly name = "imessage";
  private loaded: Promise<iMessageAdapter> | undefined;
  private implementation: iMessageAdapter | undefined;
  private listening: ReturnType<typeof setInterval> | undefined;
  private window: AbortController | undefined;
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  constructor(readonly config: PhotonAdapterConfig) {}

  get userName() {
    return this.implementation?.userName ?? "imessage";
  }
  private load() {
    this.loaded ??= (async () => {
      // The constructor, unlike createiMessageAdapter, never falls back to IMESSAGE_* env vars.
      const { iMessageAdapter } = await import("@photon-ai/chat-adapter-imessage");
      this.implementation = new iMessageAdapter({
        logger: photonLogger,
        projectId: this.config.projectId,
        projectSecret: this.config.projectSecret,
        ...(this.config.webhookSecret ? { webhookSecret: this.config.webhookSecret } : {}),
      });
      return this.implementation;
    })().catch((error: unknown) => {
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }
  async initialize(chat: ChatInstance) {
    const adapter = await this.load();
    const streaming = this.config.pollInboundMessages && !this.config.webhookSecret;
    await adapter.initialize(streaming ? this.retryingChat(chat) : chat);
    if (streaming) this.startListening(adapter);
  }

  /** The Chat instance the adapter sees while streaming: each delivery retries on failure. */
  private retryingChat(chat: ChatInstance): ChatInstance {
    const process = (
      ...[adapter, threadId, message, options, attempt = 0]: [
        ...Parameters<ChatInstance["processMessage"]>,
        number?,
      ]
    ) => {
      const task = chat.processMessage(adapter, threadId, message, options);
      task.catch((error: unknown) => {
        const delay = PHOTON_STREAM_RETRY_DELAYS_MS[attempt];
        getLogger().warn("photon inbound processing failed", {
          error: String(error),
          retrying: delay !== undefined,
        });
        if (delay === undefined || !this.listening) return;
        const timer = setTimeout(() => {
          this.retries.delete(timer);
          // The first attempt already marked the message seen.
          process(adapter, threadId, message, { ...options, deduplicate: false }, attempt + 1);
        }, delay);
        timer.unref?.();
        this.retries.add(timer);
      });
      return task;
    };
    return new Proxy(chat, {
      get: (target, key) => {
        if (key === "processMessage") return process;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Stop consuming the inbound stream; the surface calls this on shutdown. */
  async stopPolling() {
    clearInterval(this.listening);
    this.listening = undefined;
    this.window?.abort();
    this.window = undefined;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  private startListening(adapter: iMessageAdapter) {
    if (this.listening) return;
    const options: WebhookOptions = {
      // Failures are retried by retryingChat; nothing needs to wait here.
      waitUntil: (task) => {
        task.catch(() => undefined);
      },
    };
    const listen = () => {
      // A fresh window each time keeps abort listeners from piling up on one signal.
      this.window = new AbortController();
      adapter
        .startGatewayListener(options, PHOTON_LISTEN_WINDOW_MS, this.window.signal)
        .then((response) => {
          if (!response.ok) {
            getLogger().warn("photon inbound listener did not start", { status: response.status });
          }
        })
        .catch((error: unknown) => {
          getLogger().warn("photon inbound listener failed", { error: String(error) });
        });
    };
    listen();
    this.listening = setInterval(listen, PHOTON_LISTEN_WINDOW_MS);
    this.listening.unref?.();
  }

  async handleWebhook(request: Request, options?: WebhookOptions) {
    return (await this.load()).handleWebhook(request, options);
  }
  async postMessage(threadId: string, message: AdapterPostableMessage) {
    return (await this.load()).postMessage(threadId, message);
  }
  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
    return (await this.load()).editMessage(threadId, messageId, message);
  }
  async deleteMessage(threadId: string, messageId: string) {
    await (await this.load()).deleteMessage(threadId, messageId);
  }
  async addReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    await (await this.load()).addReaction(threadId, messageId, emoji);
  }
  async removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    await (await this.load()).removeReaction(threadId, messageId, emoji);
  }
  async startTyping(threadId: string) {
    await (await this.load()).startTyping(threadId);
  }
  async fetchMessage(threadId: string, messageId: string) {
    return (await this.load()).fetchMessage(threadId, messageId);
  }
  async fetchMessages(threadId: string) {
    return (await this.load()).fetchMessages(threadId);
  }
  async fetchThread(threadId: string) {
    return (await this.load()).fetchThread(threadId);
  }
  async openDM(userId: string) {
    return (await this.load()).openDM(userId);
  }
  async disconnect() {
    await this.stopPolling();
  }
  parseMessage(raw: unknown) {
    if (!this.implementation) throw new Error("Photon adapter is not initialized");
    return this.implementation.parseMessage(raw);
  }
  renderFormatted(content: FormattedContent) {
    return this.implementation?.renderFormatted(content) ?? stringifyMarkdown(content);
  }
  encodeThreadId(platformData: PhotonThreadId) {
    return encodePhotonThreadId(platformData);
  }
  decodeThreadId(threadId: string) {
    return decodePhotonThreadId(threadId);
  }
  channelIdFromThreadId(threadId: string) {
    return threadId;
  }
  isDM(threadId: string) {
    return decodePhotonThreadId(threadId).chatGuid.includes(";-;");
  }
}
