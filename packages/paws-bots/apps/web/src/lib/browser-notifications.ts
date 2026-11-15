import type { ProductEvent } from "@rakazo/contracts";
import {
  displayName,
  memberMessageAlerts,
  messageUnreadFor,
  payloadAuthor,
  plainTextFromMarkdown,
  TAKEOVER_COMPUTER_PENDING_STATE,
} from "@rakazo/core";
import { i18n } from "./i18n";

export type BrowserNotificationPermission = "default" | "denied" | "granted";

export type BrowserNotificationApi = {
  readonly permission: BrowserNotificationPermission;
  requestPermission(): Promise<BrowserNotificationPermission>;
};

let permissionRequest: Promise<BrowserNotificationPermission> | null = null;

export function requestBrowserNotificationPermission(
  api: BrowserNotificationApi | undefined = typeof Notification === "undefined"
    ? undefined
    : Notification,
): Promise<BrowserNotificationPermission> | undefined {
  if (!api) return undefined;
  if (api.permission !== "default") return Promise.resolve(api.permission);
  if (permissionRequest) return permissionRequest;
  try {
    permissionRequest = api.requestPermission().then(
      (permission) => {
        permissionRequest = null;
        return permission;
      },
      () => {
        permissionRequest = null;
        return api.permission;
      },
    );
  } catch {
    return Promise.resolve(api.permission);
  }
  return permissionRequest;
}

export type BrowserNotificationContext = {
  subscribedThreadId: string;
  initialCursor: number;
  streamReady: boolean;
  pageVisible: boolean;
  windowFocused: boolean;
  permission: BrowserNotificationPermission;
  notifiedEventIds: ReadonlySet<string>;
  /** The signed-in person: another member's message is news to them, their own is not. */
  meId?: string;
};

/** A card that only asks for the screen shares the takeover alert's tag, so the two show as one
 * notification; a viewer who gets no takeover alert still sees the card. */
function pendingTakeoverOnly(event: Pick<ProductEvent, "type" | "payload">): boolean {
  if (event.type !== "thread.message.created") return false;
  const blocks = event.payload.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.every(
    (block) =>
      !!block &&
      typeof block === "object" &&
      "kind" in block &&
      block.kind === "computer" &&
      "state" in block &&
      block.state === TAKEOVER_COMPUTER_PENDING_STATE,
  );
}

export function shouldNotifyBrowser(
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "seq" | "payload">,
  context: BrowserNotificationContext,
): boolean {
  const notifiable =
    (event.type === "thread.message.created" &&
      messageUnreadFor(event.payload, context.meId) &&
      (event.payload.role === "bot" || memberMessageAlerts(event.payload))) ||
    event.type === "run.failed" ||
    event.type === "run.cancelled";
  return (
    context.streamReady &&
    notifiable &&
    event.threadId === context.subscribedThreadId &&
    event.seq > context.initialCursor &&
    (!context.pageVisible || !context.windowFocused) &&
    context.permission === "granted" &&
    !context.notifiedEventIds.has(event.id)
  );
}

export function browserNotificationMessage(
  event: Pick<ProductEvent, "type" | "payload">,
  botName: string,
): { title: string; body: string } {
  const name = displayName(botName, i18n._({ id: "Bot", message: "Bot" }));
  if (event.type === "thread.message.created") {
    const blocks = Array.isArray(event.payload.blocks) ? event.payload.blocks : [];
    const body = blocks
      .map((block) =>
        block && typeof block === "object" && "text" in block && typeof block.text === "string"
          ? plainTextFromMarkdown(block.text)
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    const text = body || i18n._({ id: "Message", message: "Message" });
    // Another member's message says who wrote it, as their push does.
    const author = event.payload.role === "user" ? payloadAuthor(event.payload).author : undefined;
    return { title: name, body: author ? `${author.name}: ${text}` : text };
  }
  if (event.type === "run.failed") {
    return {
      title: i18n._({ id: "{name} failed", message: "{name} failed", values: { name } }),
      body: i18n._({ id: "Failed.", message: "Failed." }),
    };
  }
  if (event.type === "run.cancelled") {
    return {
      title: i18n._({ id: "{name} stopped", message: "{name} stopped", values: { name } }),
      body: i18n._({ id: "Stopped.", message: "Stopped." }),
    };
  }
  return {
    title: i18n._({ id: "{name} finished", message: "{name} finished", values: { name } }),
    body: i18n._({ id: "Finished.", message: "Finished." }),
  };
}

export function deliverBrowserNotification(
  event: Pick<ProductEvent, "id" | "type" | "threadId" | "payload">,
  botName: string,
  context: {
    enabled: boolean;
    pageVisible: boolean;
    windowFocused: boolean;
    permission: BrowserNotificationPermission;
    notifiedEventIds: Set<string>;
    show: (title: string, body: string, tag: string) => void;
  },
): "delivered" | "pending" | "discarded" {
  if (
    !context.enabled ||
    (context.pageVisible && context.windowFocused) ||
    context.notifiedEventIds.has(event.id) ||
    context.permission === "denied"
  ) {
    return "discarded";
  }
  if (context.permission === "default") return "pending";
  const message = browserNotificationMessage(event, botName);
  try {
    const tag = pendingTakeoverOnly(event) ? `${event.threadId}:takeover` : event.threadId;
    context.show(message.title, message.body, tag);
    context.notifiedEventIds.add(event.id);
    return "delivered";
  } catch {
    return "pending";
  }
}
