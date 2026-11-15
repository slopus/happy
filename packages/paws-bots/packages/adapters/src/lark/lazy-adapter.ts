import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FormattedContent,
  WebhookOptions,
} from "chat";
import { NotImplementedError, stringifyMarkdown } from "chat";
import type { LarkAdapter } from "./lark-adapter.js";
import type { Domain } from "./thread-id.js";
import { decodeThreadId, encodeThreadId } from "./thread-id.js";

export interface LarkAdapterConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  domain: Domain;
  httpInstance?: HttpInstance;
}

export class LarkAdapterBase {
  encodeThreadId = encodeThreadId;
  decodeThreadId = decodeThreadId;
  channelIdFromThreadId(threadId: string) {
    return decodeThreadId(threadId).chatId;
  }
  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content);
  }
  async startTyping() {}
  async fetchMessages(): Promise<never> {
    throw new NotImplementedError("Lark message history is not supported");
  }
  async fetchThread(): Promise<never> {
    throw new NotImplementedError("Lark thread metadata is not supported");
  }
  async addReaction(): Promise<never> {
    throw new NotImplementedError("Lark reactions are not supported");
  }
  async removeReaction(): Promise<never> {
    throw new NotImplementedError("Lark reactions are not supported");
  }
}

/** Keeps both the implementation and official SDK out of unconfigured processes. */
export class LazyLarkAdapter extends LarkAdapterBase implements Adapter {
  readonly name = "lark";
  readonly incomingConfig = { events: "webhook", callbacks: "webhook" } as const;
  private loaded: Promise<LarkAdapter> | undefined;
  private implementation: LarkAdapter | undefined;
  constructor(readonly config: LarkAdapterConfig) {
    super();
  }
  get userName() {
    return this.implementation?.userName ?? "lark";
  }
  get botUserId() {
    return this.implementation?.botUserId;
  }
  private load() {
    this.loaded ??= (async () => {
      const { createLarkAdapter } = await import("./lark-adapter.js");
      this.implementation = await createLarkAdapter(this.config);
      return this.implementation;
    })();
    return this.loaded;
  }
  async initialize(chat: ChatInstance) {
    await (await this.load()).initialize(chat);
  }
  async handleWebhook(request: Request, options?: WebhookOptions) {
    return (await this.load()).handleWebhook(request, options);
  }
  async postMessage(threadId: string, message: AdapterPostableMessage, idempotencyKey?: string) {
    return (await this.load()).postMessage(threadId, message, idempotencyKey);
  }
  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
    return (await this.load()).editMessage(threadId, messageId, message);
  }
  async deleteMessage(threadId: string, messageId: string) {
    await (await this.load()).deleteMessage(threadId, messageId);
  }
  async openDM(userId: string) {
    return (await this.load()).openDM(userId);
  }
  async disconnect() {
    await this.implementation?.disconnect();
  }
  isDM(threadId: string) {
    return this.implementation?.isDM(threadId) ?? false;
  }
  parseMessage(raw: unknown) {
    if (!this.implementation) throw new Error("Lark adapter is not initialized");
    return this.implementation.parseMessage(raw);
  }
}
