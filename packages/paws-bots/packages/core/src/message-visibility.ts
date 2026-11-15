import type { MessageBlock } from "@rakazo/contracts";
import { messageReaction } from "./message-reactions.js";

type PresentableMessage = {
  id: string;
  runId?: string;
  role?: string;
  replyToMessageId?: string | null;
  blocks: readonly MessageBlock[];
};

export type UserVisibleMessagesOptions = {
  /**
   * Keep `bot_message_sent` / `bot_message_received` rows as compact chips
   * (web CollaborationMarker; mobile AgentEventLabel). Peer replies fold under the received chip.
   */
  includePeerReceipts?: boolean;
  /** Peer-run ids from `run.trigger === "bot_message"` when receipts may be out of window. */
  knownPeerRunIds?: Iterable<string>;
  /**
   * Run ids for background triggers (e.g. `tickets`). Their messages are hidden
   * except cards that need user input.
   */
  backgroundRunIds?: Iterable<string>;
  /**
   * Surface a peer-run's own `text` reply (e.g. a delegating bot's summary to the user)
   * alongside `ask` cards. Defaults to true for chat-thread rendering; set false for
   * contexts like sidebar previews that should never echo peer chatter. A relay of delegated
   * work is the bot's own reply to the user and stays either way.
   */
  includeDelegatedReplyText?: boolean;
};

/** What woke the bot (see the `delivery` block): its prompt, never shown as a message. */
export function isDeliveryMessage(blocks: readonly unknown[]): boolean {
  // Also reads stored JSON, whose elements are not checked.
  return blocks.some((block) => (block as { kind?: unknown } | null)?.kind === "delivery");
}

export function isPeerReceiptBlocks(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
}

/** User-input cards remain visible when their run otherwise stays in the background. */
export function isBackgroundInputBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    "kind" in block &&
    (block.kind === "ask" ||
      block.kind === "computer" ||
      block.kind === "mcp_approval" ||
      block.kind === "app_connect")
  );
}

/** Cards a peer run stays inline for: the user has to act on them. */
function isPeerInputBlock(block: MessageBlock): boolean {
  return isBackgroundInputBlock(block) || block.kind === "choice";
}

function isAskBlock(block: MessageBlock): boolean {
  return block.kind === "ask";
}

/**
 * Another bot handing this bot new work: a request or question that does not thread back to a
 * message of this bot's. The run's reply goes back to that bot. Anything else (results, statuses,
 * FYIs, and questions about work this bot delegated) wakes it to speak to the user.
 */
function startsPeerWork(message: PresentableMessage): boolean {
  return (
    !message.replyToMessageId &&
    message.blocks.some(
      (block) =>
        block.kind === "bot_message_received" &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    )
  );
}

export type FoldedTranscript<T> = {
  messages: T[];
  /** Peer-run replies keyed by the id of the `bot_message_received` marker they fold under. */
  folded: ReadonlyMap<string, readonly T[]>;
  /** The marker each folded message folds under, so a jump can expand it. */
  markerOf: ReadonlyMap<string, string>;
  /** The "Messaged X" receipt each dropped relay marker merged into, so a jump lands there. */
  mergedInto: ReadonlyMap<string, string>;
};

/** Where a jump to a message lands: a dropped relay marker resolves to its receipt. */
export function jumpTargetId(transcript: FoldedTranscript<unknown>, messageId: string): string {
  return transcript.mergedInto.get(messageId) ?? messageId;
}

/**
 * Drop peer-run activity; optionally keep sent/received receipt rows. With receipts kept, a
 * peer run's bot text replies fold under its received marker when another bot handed it work;
 * its user-input cards stay inline, and so do replies about work it delegated itself. Such a
 * relay's marker is dropped when its "Messaged X" receipt is loaded, so the chat shows one chip.
 */
export function foldPeerReplies<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): FoldedTranscript<T> {
  const includePeerReceipts = options.includePeerReceipts === true;
  const markerByRunId = new Map<string, string>();
  // Runs not woken by new work from another bot: their replies are for the user.
  const relayRunIds = new Set<string>();
  const sentReceiptIds = new Set(
    messages
      .filter((message) => message.blocks.some((block) => block.kind === "bot_message_sent"))
      .map((message) => message.id),
  );
  // A relay's marker that threads back to this bot's own "Messaged X" receipt adds nothing: that
  // receipt already opens the exchange, and the relay then reads as this bot's own reply.
  const mergedInto = new Map<string, string>();
  for (const message of messages) {
    if (!message.blocks.some((block) => block.kind === "bot_message_received")) continue;
    const relay = !startsPeerWork(message);
    if (
      includePeerReceipts &&
      relay &&
      message.replyToMessageId &&
      sentReceiptIds.has(message.replyToMessageId)
    ) {
      mergedInto.set(message.id, message.replyToMessageId);
    }
    if (message.runId && !markerByRunId.has(message.runId)) {
      markerByRunId.set(message.runId, message.id);
      if (relay) relayRunIds.add(message.runId);
    }
  }
  const peerRunIds = new Set([...(options.knownPeerRunIds ?? []), ...markerByRunId.keys()]);
  const backgroundRunIds = new Set(options.backgroundRunIds ?? []);
  const includeText = options.includeDelegatedReplyText !== false;
  const folded = new Map<string, T[]>();
  const markerOf = new Map<string, string>();
  const fold = (markerId: string, message: T) => {
    folded.set(markerId, [...(folded.get(markerId) ?? []), message]);
    markerOf.set(message.id, markerId);
    return false;
  };

  const visible = messages.filter((message) => {
    // What woke the bot (a webhook, an email, a chat message) is its prompt, not a message to
    // show; like a scheduled routine, only what the bot does with it appears.
    if (isDeliveryMessage(message.blocks)) return false;
    if (message.runId && backgroundRunIds.has(message.runId)) {
      return message.blocks.some(isBackgroundInputBlock);
    }
    if (isPeerReceiptBlocks(message.blocks)) {
      return includePeerReceipts && !mergedInto.has(message.id);
    }
    // A reaction folds with its folded parent so the count shows when the parent is expanded.
    const parentMarkerId = message.replyToMessageId
      ? markerOf.get(message.replyToMessageId)
      : undefined;
    if (
      parentMarkerId !== undefined &&
      message.role !== undefined &&
      messageReaction({ ...message, role: message.role, blocks: [...message.blocks] })
    )
      return fold(parentMarkerId, message);
    if (!message.runId || !peerRunIds.has(message.runId)) return true;
    // User-input cards stay inline; previews without receipts keep only asks.
    if (message.blocks.some(includePeerReceipts ? isPeerInputBlock : isAskBlock)) return true;
    // A relay is the bot's own reply to the user, so previews show it too.
    if (
      (!includeText && !relayRunIds.has(message.runId)) ||
      !message.blocks.some(
        (block) =>
          block.kind === "text" ||
          block.kind === "file" ||
          block.kind === "image" ||
          block.kind === "chart" ||
          block.kind === "app" ||
          block.kind === "page",
      )
    )
      return false;
    // Only bot replies fold: a person's answer, steering or reaction in the run stays inline.
    if (message.role !== "bot") return true;
    if (relayRunIds.has(message.runId)) return true;
    const markerId = includePeerReceipts ? markerByRunId.get(message.runId) : undefined;
    // A reply whose marker is outside the loaded page stays inline.
    if (markerId === undefined) return true;
    return fold(markerId, message);
  });
  return { messages: visible, folded, markerOf, mergedInto };
}

export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  options: UserVisibleMessagesOptions = {},
): T[] {
  return foldPeerReplies(messages, options).messages;
}

/** The transcript with each expanded marker's folded replies drawn right after it. */
export function expandPeerReplies<T extends PresentableMessage>(
  transcript: FoldedTranscript<T>,
  expandedMarkerIds: ReadonlySet<string>,
): T[] {
  if (expandedMarkerIds.size === 0) return transcript.messages;
  return transcript.messages.flatMap((message) =>
    expandedMarkerIds.has(message.id)
      ? [message, ...(transcript.folded.get(message.id) ?? [])]
      : [message],
  );
}
