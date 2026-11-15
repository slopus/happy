import { createHash } from "node:crypto";
import type { TelegramAdapter } from "@chat-adapter/telegram";
import {
  createTelegramAdapter,
  escapeMarkdownV2,
  TelegramFormatConverter,
} from "@chat-adapter/telegram";
import {
  createWhatsAppAdapter,
  splitMessage,
  WhatsAppAdapter,
  WhatsAppApiError,
} from "@chat-adapter/whatsapp";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import type { MessagingInboundMessage, MessagingOutboundStatus } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { Adapter } from "chat";
import {
  ConsoleLogger,
  convertEmojiPlaceholders,
  isLinkNode,
  markdownToPlainText,
  parseMarkdown,
  text,
  toPlainText,
  walkAst,
} from "chat";
import type { SendblueAdapterConfig, SendblueThreadId } from "chat-adapter-sendblue";
import type { ClientOptions as SendblueClientOptions } from "sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { boundInboundMarkdown } from "./chat-sdk-surface.js";
import { LazyLarkAdapter } from "./lark/lazy-adapter.js";
import { Domain } from "./lark/thread-id.js";
import { lazyChatAdapter } from "./lazy-chat-adapter.js";
import { LazyPhotonAdapter } from "./photon/lazy-adapter.js";
import { isVitestRuntime } from "./test-runtime.js";

/**
 * Parsed platform credentials, filled from process.env at the composition
 * roots. A platform mounts when its full credential set is present.
 */
export interface MessagingEnvironmentValues {
  /** Public API origin; vendors that push delivery status call back here. */
  apiUrl?: string | undefined;
  sendblueApiKeyId?: string | undefined;
  sendblueApiSecret?: string | undefined;
  sendblueSigningSecret?: string | undefined;
  sendbluePhoneNumber?: string | undefined;
  slackBotToken?: string | undefined;
  slackSigningSecret?: string | undefined;
  teamsAppId?: string | undefined;
  teamsAppPassword?: string | undefined;
  teamsAppTenantId?: string | undefined;
  whatsappAccessToken?: string | undefined;
  whatsappPhoneNumberId?: string | undefined;
  whatsappAppSecret?: string | undefined;
  whatsappVerifyToken?: string | undefined;
  telegramBotToken?: string | undefined;
  telegramWebhookSecret?: string | undefined;
  /** Extra named Telegram bots (TELEGRAM_BOT_TOKEN_<NAME>), e.g. one per space. */
  telegramBots?: TelegramBotCredentials[] | undefined;
  larkAppId?: string | undefined;
  larkAppSecret?: string | undefined;
  larkVerificationToken?: string | undefined;
  larkEncryptKey?: string | undefined;
  larkDomain?: string | undefined;
  photonProjectId?: string | undefined;
  photonProjectSecret?: string | undefined;
  photonWebhookSecret?: string | undefined;
  /** Extra named Photon projects (PHOTON_PROJECT_ID_<NAME>), each with its own number. */
  photonProjects?: PhotonProjectCredentials[] | undefined;
}

export function messagingEnvFromProcess(
  env: Record<string, string | undefined>,
): MessagingEnvironmentValues {
  // Same trim/empty-to-undefined normalization the API's env loader applies,
  // so a credential with stray whitespace behaves identically in both roles.
  const clean = (value: string | undefined) => value?.trim() || undefined;
  return {
    apiUrl: clean(env.API_URL),
    sendblueApiKeyId: clean(env.SENDBLUE_API_KEY_ID),
    sendblueApiSecret: clean(env.SENDBLUE_API_SECRET),
    sendblueSigningSecret: clean(env.SENDBLUE_SIGNING_SECRET),
    sendbluePhoneNumber: clean(env.SENDBLUE_PHONE_NUMBER),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackSigningSecret: clean(env.SLACK_SIGNING_SECRET),
    teamsAppId: clean(env.TEAMS_APP_ID),
    teamsAppPassword: clean(env.TEAMS_APP_PASSWORD),
    teamsAppTenantId: clean(env.TEAMS_APP_TENANT_ID),
    whatsappAccessToken: clean(env.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: clean(env.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: clean(env.WHATSAPP_VERIFY_TOKEN),
    telegramBotToken: clean(env.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecret: clean(env.TELEGRAM_WEBHOOK_SECRET_TOKEN),
    telegramBots: telegramBotsFromEnv(env),
    larkAppId: clean(env.LARK_APP_ID),
    larkAppSecret: clean(env.LARK_APP_SECRET),
    larkVerificationToken: clean(env.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: clean(env.LARK_ENCRYPT_KEY),
    larkDomain: clean(env.LARK_DOMAIN),
    photonProjectId: clean(env.PHOTON_PROJECT_ID),
    photonProjectSecret: clean(env.PHOTON_PROJECT_SECRET),
    photonWebhookSecret: clean(env.PHOTON_WEBHOOK_SECRET),
    photonProjects: photonProjectsFromEnv(env),
  };
}

/** One extra Telegram bot, mounted as provider `telegram-<name>`. */
export interface TelegramBotCredentials {
  name: string;
  botToken: string;
  webhookSecret: string;
}

const TELEGRAM_NAMED_TOKEN = /^TELEGRAM_BOT_TOKEN_([A-Z0-9]+)$/;

/**
 * Extra Telegram bots from TELEGRAM_BOT_TOKEN_<NAME> plus
 * TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>. Each is its own Telegram bot (own
 * token, own getUpdates slot), so one person can link a different Rakazo bot
 * — typically one per space — to each. <NAME> is letters and digits only and
 * becomes the provider id `telegram-<name>` (lowercased), which also names
 * its webhook route. A name with no secret is skipped, like the default bot.
 */
export function telegramBotsFromEnv(
  env: Record<string, string | undefined>,
): TelegramBotCredentials[] {
  const bots: TelegramBotCredentials[] = [];
  for (const [key, value] of Object.entries(env)) {
    const suffix = TELEGRAM_NAMED_TOKEN.exec(key)?.[1];
    if (!suffix) continue;
    const botToken = value?.trim();
    const webhookSecret = env[`TELEGRAM_WEBHOOK_SECRET_TOKEN_${suffix}`]?.trim();
    if (!botToken || !webhookSecret) continue;
    bots.push({ name: suffix.toLowerCase(), botToken, webhookSecret });
  }
  bots.sort((a, b) => a.name.localeCompare(b.name));
  return bots;
}

/** One extra Photon project, mounted as provider `photon-<name>`. */
export interface PhotonProjectCredentials {
  name: string;
  projectId: string;
  projectSecret: string;
  webhookSecret?: string | undefined;
}

const PHOTON_NAMED_PROJECT = /^PHOTON_PROJECT_ID_([A-Z0-9]+)$/;

/**
 * Extra Photon projects from PHOTON_PROJECT_ID_<NAME> plus
 * PHOTON_PROJECT_SECRET_<NAME> (and optionally PHOTON_WEBHOOK_SECRET_<NAME>).
 * Photon gives each person a different number in each project, so one person
 * can link a different Rakazo bot to each, as with named Telegram bots.
 * <NAME> is letters and digits only and becomes the provider id
 * `photon-<name>` (lowercased), which also names its webhook route.
 */
export function photonProjectsFromEnv(
  env: Record<string, string | undefined>,
): PhotonProjectCredentials[] {
  const projects: PhotonProjectCredentials[] = [];
  for (const [key, value] of Object.entries(env)) {
    const suffix = PHOTON_NAMED_PROJECT.exec(key)?.[1];
    if (!suffix) continue;
    const projectId = value?.trim();
    const projectSecret = env[`PHOTON_PROJECT_SECRET_${suffix}`]?.trim();
    if (!projectId || !projectSecret) continue;
    const webhookSecret = env[`PHOTON_WEBHOOK_SECRET_${suffix}`]?.trim() || undefined;
    projects.push({ name: suffix.toLowerCase(), projectId, projectSecret, webhookSecret });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

/**
 * Group conversations stay sendblue-only until channel semantics are mapped
 * for the other platforms.
 *
 * `pollInboundMessages` must be true only in the one process that registers
 * the inbound sink. Telegram's "auto" mode long-polls as soon as anything,
 * including a lazy outbound send, initializes the chat, and a second poller
 * steals Telegram's single getUpdates slot, so both processes lose 409
 * Conflicts and messages stop arriving. Send-only callers leave it false.
 */
export function messagingPlatformsFromEnv(
  env: MessagingEnvironmentValues,
  options: {
    pollInboundMessages?: boolean;
    /** Test seam: point the Sendblue SDK at an emulator. */
    sendblueTransport?: Pick<SendblueClientOptions, "baseURL" | "fetch">;
    /** Test seam: replace only the official Lark SDK HTTP boundary. */
    larkTransport?: HttpInstance;
  } = {},
): MessagingPlatform[] {
  const platforms: MessagingPlatform[] = [];

  if (
    env.sendblueApiKeyId &&
    env.sendblueApiSecret &&
    env.sendblueSigningSecret &&
    env.sendbluePhoneNumber
  ) {
    const lineNumber = env.sendbluePhoneNumber;
    const config: Partial<SendblueAdapterConfig> = {
      apiKey: env.sendblueApiKeyId,
      apiSecret: env.sendblueApiSecret,
      defaultFromNumber: lineNumber,
      webhookSecret: env.sendblueSigningSecret,
      allowedServices: ["iMessage", "SMS", "RCS"],
      // Delivery-status callbacks need a public HTTPS origin; local setups skip them.
      ...(env.apiUrl?.startsWith("https://")
        ? { statusCallbackUrl: new URL("/api/v1/messaging/webhook/sendblue", env.apiUrl).href }
        : {}),
    };
    // chat@4.39 derives thread.isDM solely from the optional Adapter.isDM
    // hook, and chat-adapter-sendblue@0.2.0 omits it — without this every
    // 1:1 message would route as a group. Derive it from the thread id.
    const isDM = (threadId: string) => !decodeSendblueThreadId(threadId).groupId;
    const adapter = lazyChatAdapter(
      "sendblue",
      async () => {
        const { createSendblueAdapter } = await import("chat-adapter-sendblue");
        const sendblue = createSendblueAdapter(config);
        // The SDK's own retries (twice, no idempotency key) would duplicate
        // texts and stall the outbox drain; the outbox owns retries instead.
        Object.assign(sendblue, {
          isDM,
          sdk: sendblue.getSdk().withOptions({
            maxRetries: 0,
            timeout: MESSAGING_SEND_TIMEOUT_MS,
            ...options.sendblueTransport,
          }),
        });
        return sendblue;
      },
      { encodeThreadId: encodeSendblueThreadId, decodeThreadId: decodeSendblueThreadId, isDM },
    );
    platforms.push({
      provider: "sendblue",
      capabilities: { direct: true, groups: true, receipt: "typing" },
      adapter,
      address: lineNumber,
      directThreadId: (address) =>
        encodeSendblueThreadId({ fromNumber: lineNumber, contactNumber: address }),
      peekStatuses: parseSendblueStatuses,
      participants: (raw) => sendblueParticipants(raw, lineNumber),
      rosterAt: (raw) => sendblueRosterAt(raw),
      channelName: (raw) => sendblueGroupName(raw),
      transport: (raw) => sendblueTransport(raw),
    });
  }

  if (env.slackBotToken && env.slackSigningSecret) {
    const config = {
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      // WebClient defaults to ten retries over ~30 minutes with no timeout,
      // sleeping through rate limits; that duplicates posts and stalls the
      // outbox. Fail fast and let the outbox back off (honouring retryAfter).
      webClientOptions: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: MESSAGING_SEND_TIMEOUT_MS,
      },
    };
    const adapter = lazyChatAdapter("slack", async () => {
      const { createSlackAdapter } = await import("@chat-adapter/slack");
      const slack = createSlackAdapter(config);
      boundInboundMarkdown(slack);
      // Slack's reactions.add fails with already_reacted when a replayed inbound reacts twice.
      const addReaction = slack.addReaction.bind(slack);
      Object.assign(slack, {
        addReaction: (threadId, messageId, emoji) =>
          addReaction(threadId, messageId, emoji).catch((error: unknown) => {
            if (slackPlatformError(error) !== "already_reacted") throw error;
          }),
      } satisfies Pick<Adapter, "addReaction">);
      return slack;
    });
    platforms.push({
      provider: "slack",
      capabilities: { direct: true, groups: true, receipt: "reaction" },
      adapter,
      enrichTeamRoom: enrichSlackTeamRoom,
      redeliveryKeys: slackRedeliveryKeys,
      isPermanentSendError: (error) => SLACK_PERMANENT_ERRORS.has(slackPlatformError(error) ?? ""),
    });
  }

  // Single-tenant credentials keep enterprise installations scoped to their tenant.
  // Channels and group chats stay disabled until their room semantics are mapped.
  if (env.teamsAppId && env.teamsAppPassword && env.teamsAppTenantId) {
    const config = {
      appId: env.teamsAppId,
      appPassword: env.teamsAppPassword,
      appTenantId: env.teamsAppTenantId,
      appType: "SingleTenant" as const,
    };
    platforms.push({
      provider: "teams",
      capabilities: { direct: true, groups: false, receipt: "typing" },
      adapter: lazyChatAdapter("teams", async () => {
        const { createTeamsAdapter } = await import("@chat-adapter/teams");
        const adapter = createTeamsAdapter(config);
        boundInboundMarkdown(adapter);
        return adapter;
      }),
    });
  }

  if (
    env.whatsappAccessToken &&
    env.whatsappPhoneNumberId &&
    env.whatsappAppSecret &&
    env.whatsappVerifyToken
  ) {
    platforms.push({
      provider: "whatsapp",
      capabilities: { direct: true, groups: false, receipt: null },
      adapter: createWhatsAppAdapter({
        accessToken: env.whatsappAccessToken,
        phoneNumberId: env.whatsappPhoneNumberId,
        appSecret: env.whatsappAppSecret,
        verifyToken: env.whatsappVerifyToken,
      }),
      peekStatuses: parseWhatsAppStatuses,
      isPermanentSendError: (error) =>
        error instanceof WhatsAppApiError && error.errorCode === WHATSAPP_REENGAGEMENT_REQUIRED,
    });
  }

  const telegramTokens = new Set<string>();
  // Both required: without the secret token the adapter accepts unsigned
  // webhook posts, so a forged update could reach inbound processing.
  if (env.telegramBotToken && env.telegramWebhookSecret) {
    telegramTokens.add(env.telegramBotToken.trim());
    const adapter = telegramAdapter(env.telegramBotToken, env.telegramWebhookSecret, options);
    platforms.push({
      provider: "telegram",
      capabilities: { direct: true, groups: true, receipt: null, files: true },
      ...withTelegramRedelivery(adapter),
      ...telegramGroupHooks(adapter),
      isPermanentSendError: isTelegramBlocked,
    });
  }

  // Same rules as the default bot; each named bot has its own token and so
  // its own getUpdates slot. The surface maps their native "telegram:" thread
  // ids to "telegram-<name>:" so conversations with each bot stay distinct.
  for (const bot of env.telegramBots ?? []) {
    if (telegramTokens.has(bot.botToken.trim())) {
      getLogger().warn("skipping Telegram bot that reuses another bot's token", {
        provider: `telegram-${bot.name}`,
      });
      continue;
    }
    telegramTokens.add(bot.botToken.trim());
    const adapter = telegramAdapter(bot.botToken, bot.webhookSecret, options);
    platforms.push({
      provider: `telegram-${bot.name}`,
      adapterName: "telegram",
      capabilities: { direct: true, groups: true, receipt: null, files: true },
      ...withTelegramRedelivery(adapter),
      ...telegramGroupHooks(adapter),
      isPermanentSendError: isTelegramBlocked,
    });
  }

  // App ID, secret, and verification token are all required: without the
  // token the adapter accepts unsigned webhook posts. Encrypt key and
  // domain are optional (event encryption / open.feishu.cn vs open.larksuite.com).
  if (env.larkAppId && env.larkAppSecret && env.larkVerificationToken) {
    // Webhook-only: ws/long-connection incoming would consume events so
    // the HTTP webhook at /api/v1/messaging/webhook/lark never sees them.
    const adapter = new LazyLarkAdapter({
      ...(options.larkTransport ? { httpInstance: options.larkTransport } : {}),
      appId: env.larkAppId,
      appSecret: env.larkAppSecret,
      verificationToken: env.larkVerificationToken,
      // Explicit defaults prevent the adapter from rereading untrimmed process.env values.
      encryptKey: env.larkEncryptKey ?? "",
      domain: env.larkDomain?.toLowerCase() === "lark" ? Domain.Lark : Domain.Feishu,
    });
    platforms.push({
      provider: "lark",
      capabilities: { direct: true, groups: false, receipt: null },
      adapter,
      postOnce: (threadId, message, idempotencyKey) =>
        adapter.postMessage(threadId, message, idempotencyKey),
    });
  }

  // iMessage through Photon (Spectrum Cloud). Without a webhook secret the
  // API process consumes Spectrum's outbound gRPC stream, so no public URL is
  // needed; other processes only send. With one, Spectrum posts signed
  // webhooks to /api/v1/messaging/webhook/photon and nothing streams.
  const photonProjects: (PhotonProjectCredentials & { provider: string })[] = [];
  if (env.photonProjectId && env.photonProjectSecret) {
    photonProjects.push({
      provider: "photon",
      name: "",
      projectId: env.photonProjectId,
      projectSecret: env.photonProjectSecret,
      webhookSecret: env.photonWebhookSecret,
    });
  }
  for (const project of env.photonProjects ?? []) {
    photonProjects.push({ ...project, provider: `photon-${project.name}` });
  }
  // Two providers on one project would both consume its single stream.
  const photonIds = new Set<string>();
  for (const project of photonProjects) {
    if (photonIds.has(project.projectId)) {
      getLogger().warn("skipping Photon project that reuses another provider's project", {
        provider: project.provider,
      });
      continue;
    }
    photonIds.add(project.projectId);
    platforms.push({
      provider: project.provider,
      adapterName: "imessage",
      capabilities: { direct: true, groups: false, receipt: "typing" },
      adapter: new LazyPhotonAdapter({
        projectId: project.projectId,
        projectSecret: project.projectSecret,
        webhookSecret: project.webhookSecret,
        pollInboundMessages: options.pollInboundMessages ?? false,
      }),
    });
  }

  return platforms;
}

/** Never live under the test runner; tests build surfaces explicitly. */
export function isMessagingEnabled(platforms: MessagingPlatform[]): boolean {
  return platforms.length > 0 && !isVitestRuntime();
}

/**
 * Linked users run on their own credentials, so linking-only deployments
 * need no deployment model. Open signup provisions users with no credential
 * of their own, so that mode requires a configured deployment model — without
 * it their runs cannot execute.
 */
export function isMessagingSurfaceEnabled(
  platforms: MessagingPlatform[],
  options: { deploymentModelConfigured: boolean; openSignup: boolean },
): boolean {
  if (!isMessagingEnabled(platforms)) return false;
  return options.openSignup ? options.deploymentModelConfigured : true;
}

/** Bounds one vendor send so a hung request cannot stall the sequential outbox drain. */
const MESSAGING_SEND_TIMEOUT_MS = 10_000;

/** chat-adapter-sendblue's thread ids, available before its module loads. */
function encodeSendblueThreadId({ fromNumber, contactNumber, groupId }: SendblueThreadId): string {
  const from = Buffer.from(fromNumber).toString("base64url");
  if (groupId) return `sendblue:${from}:g:${Buffer.from(groupId).toString("base64url")}`;
  return `sendblue:${from}:${Buffer.from(contactNumber ?? "").toString("base64url")}`;
}

function decodeSendblueThreadId(threadId: string): SendblueThreadId {
  const [prefix, from, rest, group] = threadId.split(":");
  if (prefix !== "sendblue" || from === undefined || rest === undefined) {
    throw new Error(`Invalid Sendblue thread ID: ${threadId}`);
  }
  const fromNumber = Buffer.from(from, "base64url").toString();
  return rest === "g" && group
    ? { fromNumber, groupId: Buffer.from(group, "base64url").toString() }
    : { fromNumber, contactNumber: Buffer.from(rest, "base64url").toString() };
}

/** Slack errors a retry cannot fix: the bot cannot reach the channel or its token is dead. */
const SLACK_PERMANENT_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
]);

/** Meta 131047: outside the 24-hour window only a template can reach the user. */
const WHATSAPP_REENGAGEMENT_REQUIRED = 131047;

/** WhatsApp and Telegram both cap a text message at 4096 UTF-16 units. */
const MESSAGE_PART_LIMIT = 4096;

/**
 * The key the Telegram adapter claims each webhook update under (chat-adapter
 * 4.43), released when processing fails so Telegram's retry is processed. The
 * redelivery test fails if an SDK upgrade moves it.
 */
function withTelegramRedelivery(adapter: TelegramAdapter) {
  return {
    adapter,
    redeliveryKeys: (payload: unknown) => {
      const scope = createHash("sha256").update(adapter.botUserId!).digest("hex");
      return [`${adapter.name}:webhook-update:${scope}:${asRecord(payload)?.update_id}`];
    },
  };
}

/** Split before enqueueing so retries only resend the parts that failed. */
export function splitOutboundBody(provider: string, body: string): string[] {
  if (provider === "whatsapp") return splitWhatsAppPart(body);
  if (provider !== "telegram" && !provider.startsWith("telegram-")) return [body];

  return splitTelegramPart(body);
}

/** Split like the SDK, which counts UTF-16 units, but never end a part on half an emoji. */
function splitKeepingPairs(body: string): string[] {
  const parts: string[] = [];
  let rest = body;
  while (rest.length > MESSAGE_PART_LIMIT) {
    // The SDK's first part only depends on the first MESSAGE_PART_LIMIT units.
    const [first = ""] = splitMessage(rest.slice(0, MESSAGE_PART_LIMIT + 1));
    const part = first.length > 1 && /[\uD800-\uDBFF]$/.test(first) ? first.slice(0, -1) : first;
    parts.push(part);
    rest = rest.slice(part.length).trimStart();
  }
  return rest || parts.length === 0 ? [...parts, rest] : parts;
}

const telegramFormat = new TelegramFormatConverter();

/** Plain text drops a link's address, so write it after the label first. */
function plainTextWithLinkAddresses(markdown: string): string {
  const ast = walkAst(parseMarkdown(markdown), (node) => {
    if (!isLinkNode(node)) return node;
    const label = toPlainText({
      type: "root",
      children: [{ type: "paragraph", children: node.children }],
    });
    if (!label) return text(node.url);
    const bare = node.url.replace(/^(?:https?:\/\/|mailto:)/, "");
    if (label === node.url || label === bare || label === bare.replace(/\/$/, "")) {
      return text(label);
    }
    return text(`${label} (${node.url})`);
  });
  return toPlainText(ast);
}

function splitTelegramPart(body: string, literal = false): string[] {
  const markdown = literal ? escapeMarkdownV2(body) : body;
  const plainText = literal ? body : markdownToPlainText(body);
  // The adapter truncates *after* rendering and emoji conversion, including
  // its plain-text fallback. Measure both payloads in UTF-16 units as it does.
  const payloads = [telegramFormat.fromMarkdown(markdown), plainText.trim() ? plainText : markdown];
  if (
    markdown.length <= MESSAGE_PART_LIMIT &&
    payloads.every((text) => convertEmojiPlaceholders(text, "gchat").length <= MESSAGE_PART_LIMIT)
  ) {
    return [markdown];
  }

  // Parse before splitting: cutting Markdown can turn code into prose and
  // consume literal backslashes. Oversized formatted replies use escaped text.
  if (!literal && plainText !== body) {
    return splitTelegramPart(plainTextWithLinkAddresses(body), true);
  }

  const parts = splitKeepingPairs(body);
  if (parts.length > 1) return parts.flatMap((part) => splitTelegramPart(part, literal));

  return halve(body).flatMap((half) => splitTelegramPart(half, literal));
}

/** Exposes the adapter's Markdown rendering, which the package does not export. */
class WhatsAppRenderer extends WhatsAppAdapter {
  render(markdown: string): string {
    return convertEmojiPlaceholders(this.formatConverter.renderPostable({ markdown }), "whatsapp");
  }
}

let whatsappRenderer: WhatsAppRenderer | undefined;

function splitWhatsAppPart(body: string): string[] {
  whatsappRenderer ??= new WhatsAppRenderer({
    accessToken: "",
    appSecret: "",
    logger: new ConsoleLogger("silent"),
    phoneNumberId: "",
    userName: "",
    verifyToken: "",
  });
  // The adapter re-splits anything that renders past the limit, outside the
  // queue's per-part retries and without keeping UTF-16 pairs together.
  if (whatsappRenderer.render(body).length <= MESSAGE_PART_LIMIT) return [body];

  const parts = splitKeepingPairs(body);
  return (parts.length > 1 ? parts : halve(body)).flatMap(splitWhatsAppPart);
}

/** Refines chunks that only grow beyond the limit during rendering. */
function halve(body: string): string[] {
  const midpoint = Math.floor(body.length / 2);
  const prefix = body.slice(0, midpoint);
  let boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
  if (boundary < midpoint / 2) boundary = midpoint;
  if (/[\uD800-\uDBFF]/.test(body[boundary - 1]!)) boundary--;
  return [body.slice(0, boundary), body.slice(boundary)];
}

/** Sendblue reports outbound delivery as webhooks the Chat SDK ignores. */
export function parseSendblueStatuses(payload: unknown): MessagingOutboundStatus[] {
  const body = asRecord(payload);
  const handle = body && stringField(body, "message_handle");
  if (body?.is_outbound !== true || !handle) return [];
  return [
    { type: "status", provider: "sendblue", handle, status: stringField(body, "status") ?? "" },
  ];
}

/**
 * WhatsApp reports asynchronous delivery (including 24-hour-window failures
 * such as 131047) only as `statuses[]` webhooks, which the Chat SDK skips.
 */
export function parseWhatsAppStatuses(payload: unknown): MessagingOutboundStatus[] {
  const statuses: MessagingOutboundStatus[] = [];
  for (const entry of arrayField(asRecord(payload), "entry")) {
    for (const change of arrayField(asRecord(entry), "changes")) {
      for (const item of arrayField(asRecord(asRecord(change)?.value), "statuses")) {
        const record = asRecord(item) ?? {};
        const handle = stringField(record, "id");
        const status = stringField(record, "status");
        if (!handle || !status) continue;
        statuses.push({
          type: "status",
          provider: "whatsapp",
          handle,
          status: status.toUpperCase(),
        });
      }
    }
  }
  return statuses;
}

/** Slack's marker for a dispatched event; it turns Slack's retries into no-ops. */
function slackRedeliveryKeys(payload: unknown): string[] {
  const eventId = stringField(asRecord(payload) ?? {}, "event_id");
  return eventId ? [`slack:event-delivered:${eventId}`] : [];
}

/** Telegram 403 (Chat SDK PermissionError): the user blocked the bot. */
function isTelegramBlocked(error: unknown): boolean {
  return error instanceof Error && error.name === "PermissionError";
}

function telegramAdapter(
  botToken: string,
  secretToken: string,
  options: { pollInboundMessages?: boolean },
) {
  return createTelegramAdapter({
    botToken,
    secretToken,
    // Auto mode long-polls when no webhook is registered, for deployments
    // without a public HTTPS endpoint. Only the API process may poll: it
    // owns the inbound sink, and Telegram allows one getUpdates per bot.
    mode: options.pollInboundMessages ? "auto" : "webhook",
  });
}

/**
 * Group facts shared by every Telegram bot mount. Telegram names no roster,
 * so `participants` stays unset: channel members accumulate from the senders
 * seen, and a rosterless event never sweeps anyone out. Departures arrive one
 * service message at a time instead.
 */
function telegramGroupHooks(adapter: { readonly botUserId?: string }) {
  return {
    channelName: (raw: unknown) =>
      stringField(asRecord(asRecord(raw)?.chat) ?? {}, "title") ?? null,
    acceptsGroup: (raw: unknown) => asRecord(asRecord(raw)?.chat)?.type !== "channel",
    normalizeThreadId: telegramGroupThreadId,
    departures: (raw: unknown) => telegramDepartures(raw, adapter),
  };
}

/**
 * A `left_chat_member` service message names who left or was removed. When
 * that member is this mount's own bot, the whole channel ends: Telegram
 * delivers nothing from a chat the bot is no longer in.
 */
function telegramDepartures(
  raw: unknown,
  adapter: { readonly botUserId?: string },
): { addresses: string[]; botLeft: boolean } | undefined {
  const id = asRecord(asRecord(raw)?.left_chat_member)?.id;
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  return adapter.botUserId === String(id)
    ? { addresses: [], botLeft: true }
    : { addresses: [String(id)], botLeft: false };
}

/**
 * A forum topic (`is_topic_message`) is its own conversation; a plain reply's
 * message thread id is not, so it collapses onto the group. Business thread
 * ids (`telegram:biz:<id>:<chat>`) have four segments and pass through.
 */
function telegramGroupThreadId(threadId: string, raw: unknown): string {
  if (asRecord(raw)?.is_topic_message === true) return threadId;
  const parts = threadId.split(":");
  return parts.length === 3 && parts[0] === "telegram" ? `${parts[0]}:${parts[1]}` : threadId;
}

/** Pull Slack team-room fields the Chat SDK does not expose on Message. */
export function enrichSlackTeamRoom(
  raw: unknown,
  base: MessagingInboundMessage,
): Partial<MessagingInboundMessage> {
  const root = asRecord(raw);
  if (!root) return {};
  const event = asRecord(root.event) ?? root;
  const teamId =
    stringField(root, "team_id") ?? stringField(event, "team") ?? stringField(event, "team_id");
  const eventType = stringField(event, "type");
  const botProfile = asRecord(event.bot_profile) ?? {};
  const botId = stringField(event, "bot_id") ?? stringField(botProfile, "id");
  const threadTs = stringField(event, "thread_ts");
  const channel = stringField(event, "channel");
  const enrichment: Partial<MessagingInboundMessage> = {};
  if (teamId) enrichment.workspaceId = teamId;
  if (channel) enrichment.conversationKey = channel;
  if (botId) enrichment.senderIsBot = true;
  else if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    enrichment.senderIsBot = true;
  }
  if (threadTs) enrichment.replyThreadId = threadTs;
  else enrichment.replyThreadId = null;
  if (!base.isDirect) {
    // Slack sends both app_mention and message.* for one channel mention and
    // the SDK keeps whichever arrives first, so the plain event relies on the
    // SDK's own mention check. A mention of someone else stays ambient so
    // listen policy still applies.
    enrichment.kind = eventType === "app_mention" || base.mentionsBot ? "mention" : "ambient";
  }
  return enrichment;
}

function slackPlatformError(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record?.code !== "slack_webapi_platform_error") return undefined;
  return stringField(asRecord(record.data) ?? {}, "error");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function arrayField(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function sendblueParticipants(raw: unknown, lineNumber: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const participants = (raw as { participants?: unknown }).participants;
  if (!Array.isArray(participants)) return [];
  return participants.filter(
    (entry): entry is string => typeof entry === "string" && entry !== lineNumber,
  );
}

/** When Sendblue says the roster was current: the message's send time. */
function sendblueRosterAt(raw: unknown): Date | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sent = (raw as { date_sent?: unknown }).date_sent;
  if (typeof sent !== "string") return null;
  const at = new Date(sent);
  return Number.isNaN(at.getTime()) ? null : at;
}

function sendblueGroupName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as { group_display_name?: unknown }).group_display_name;
  return typeof name === "string" && name ? name : null;
}

function sendblueTransport(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const service = (raw as { service?: unknown }).service;
  return service === "iMessage" || service === "SMS" || service === "RCS" ? service : null;
}
