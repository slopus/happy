import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingCapabilities,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { providerOfThreadId } from "./chat-sdk-surface.js";

export interface TeamChatEmulatorInbound {
  handle?: string;
  threadId?: string;
  isDirect?: boolean;
  from?: string;
  fromLabel?: string | null;
  channelName?: string | null;
  participants?: string[];
  content: string;
  mediaUrl?: string | null;
  workspaceId?: string;
  conversationKey?: string;
  kind?: MessagingInboundMessage["kind"];
  replyThreadId?: string | null;
  senderIsBot?: boolean;
  participantNames?: string[];
}

export interface TeamChatEmulatorSentPost {
  threadId: string;
  body: string;
  handle: string;
}

export interface MessagingTeamChatEmulatorOptions {
  provider?: string;
  capabilities?: Partial<MessagingCapabilities>;
}

/**
 * Deterministic team-chat helpers for CI: build inbound fixtures and record
 * outbound sends without a live Slack network.
 */
export class MessagingTeamChatEmulator implements MessagingSurface {
  readonly provider: string;
  readonly sent: TeamChatEmulatorSentPost[] = [];
  private readonly capabilities: MessagingCapabilities;
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  private handleCounter = 0;
  private inboundCounter = 0;

  constructor(options: MessagingTeamChatEmulatorOptions = {}) {
    this.provider = options.provider ?? "teamchat-emulator";
    if (!this.provider || this.provider.includes(":")) {
      throw new Error("Messaging emulator provider must be non-empty and cannot contain ':'");
    }
    this.capabilities = {
      direct: options.capabilities?.direct ?? true,
      groups: options.capabilities?.groups ?? true,
      receipt: options.capabilities?.receipt ?? null,
    };
  }

  buildInbound(partial: TeamChatEmulatorInbound): MessagingInboundMessage {
    this.inboundCounter += 1;
    const isDirect = partial.isDirect ?? false;
    const from = partial.from ?? "U-emulator";
    return {
      type: "message",
      provider: this.provider,
      handle: partial.handle ?? this.allocateHandle("inbound"),
      threadId:
        partial.threadId ??
        (isDirect ? `${this.provider}:dm:${from}` : `${this.provider}:room-${this.inboundCounter}`),
      isDirect,
      from,
      fromLabel: partial.fromLabel === undefined ? "Emulator User" : partial.fromLabel,
      channelName: isDirect ? null : (partial.channelName ?? "emulator-room"),
      participants: partial.participants ?? (isDirect ? [] : ["U-emulator", "U-peer"]),
      content: partial.content,
      mediaUrl: partial.mediaUrl ?? null,
      workspaceId: partial.workspaceId ?? "T-emulator",
      conversationKey: partial.conversationKey,
      kind: partial.kind,
      replyThreadId: partial.replyThreadId,
      senderIsBot: partial.senderIsBot,
      participantNames: partial.participantNames,
    };
  }

  describe(): AdapterDescriptor<{ providers: string[] }> {
    return {
      id: "messaging-team-chat-emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { providers: [this.provider] },
    };
  }

  platforms(): MessagingPlatformDescriptor[] {
    return [{ provider: this.provider, capabilities: { ...this.capabilities } }];
  }

  handleWebhook(provider: string, _request: Request): Promise<Response> | null {
    return provider === this.provider
      ? Promise.resolve(
          new Response("Use emitInbound() for emulator events", {
            status: 501,
          }),
        )
      : null;
  }

  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void {
    this.sink = sink;
  }

  async emitInbound(partial: TeamChatEmulatorInbound): Promise<MessagingInboundMessage> {
    if (!this.sink) throw new Error("Team chat emulator has no inbound sink");
    const event = this.buildInbound(partial);
    if (event.isDirect ? !this.capabilities.direct : !this.capabilities.groups) {
      throw new Error(`Team chat emulator does not support this conversation type`);
    }
    await this.sink(event);
    return event;
  }

  async sendToThread(
    request: MessagingSendRequest,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    this.assertProviderThread(request.threadId);
    return {
      handle: this.recordSend(request.threadId, request.body, "outbound"),
    };
  }

  async openDirectThread(
    provider: string,
    address: string,
    _context: AdapterContext,
  ): Promise<string> {
    if (provider !== this.provider) throw new Error(`Unknown messaging provider: ${provider}`);
    if (!this.capabilities.direct) {
      throw new Error(`${this.provider} emulator does not support direct messages`);
    }
    return `${this.provider}:dm:${address}`;
  }

  async acknowledge(_threadId: string, _handle: string, _context: AdapterContext): Promise<void> {}

  resetWitnesses(): void {
    this.sent.length = 0;
  }

  createPlatform(): MessagingPlatform {
    return {
      provider: this.provider,
      capabilities: { ...this.capabilities },
      // The adapter is only consulted for outbound post / openDM in unit tests that
      // drive ChatSdkMessagingSurface; prefer createRecordingMessagingSurface for
      // focused send recording without Chat SDK wiring.
      adapter: {
        version: "1.0.0",
        botUsername: "rakazo-emulator",
        postMessage: async (threadId: string, message: { text?: string }) => {
          const handle = this.recordSend(threadId, message.text ?? "", "outbound");
          return { id: handle, html_url: null };
        },
      } as unknown as MessagingPlatform["adapter"],
      directThreadId: (address) => `${this.provider}:dm:${address}`,
    };
  }

  allocateHandle(prefix: string): string {
    this.handleCounter += 1;
    return `${prefix}-${this.handleCounter}`;
  }

  recordSend(threadId: string, body: string, prefix: string): string {
    const handle = this.allocateHandle(prefix);
    this.sent.push({ threadId, body, handle });
    return handle;
  }

  private assertProviderThread(threadId: string): void {
    if (providerOfThreadId(threadId) !== this.provider) {
      throw new Error(`Thread does not belong to ${this.provider}: ${threadId}`);
    }
  }
}

/** Thin MessagingSurface stand-in that only records sendToThread for unit tests. */
export function createRecordingMessagingSurface(emulator: MessagingTeamChatEmulator): {
  sendToThread: (request: { threadId: string; body: string }) => Promise<MessagingSendResult>;
  sent: TeamChatEmulatorSentPost[];
} {
  return {
    sent: emulator.sent,
    async sendToThread(request) {
      return {
        handle: emulator.recordSend(request.threadId, request.body, "recorded"),
      };
    },
  };
}
