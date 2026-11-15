import type { MessageBlock } from "@rakazo/contracts";
import { clampBotMessage } from "./bot-messages.js";
import type { FoldedTranscript } from "./message-visibility.js";

export type PeerExchange = {
  peerBotId: string;
  peerBotName: string;
  count: number;
  direction: "sent" | "received";
};

type Message = {
  id: string;
  runId?: string;
  role?: string;
  blocks: readonly MessageBlock[];
};

/** Content shown in the read-only peer conversation, not tools or activity. */
export function isPeerReplyBlock(block: MessageBlock) {
  return (
    block.kind === "text" ||
    block.kind === "file" ||
    block.kind === "image" ||
    block.kind === "chart" ||
    block.kind === "page"
  );
}

function peerReceipt(blocks: readonly MessageBlock[]) {
  const block = blocks.find(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (block?.kind === "bot_message_sent")
    return { peerBotId: block.toBotId, peerBotName: block.toBotName, direction: "sent" as const };
  if (block?.kind === "bot_message_received")
    return {
      peerBotId: block.fromBotId,
      peerBotName: block.fromBotName,
      direction: "received" as const,
    };
  return undefined;
}

/** Match exact observable payloads within one run and peer, never similar prose across runs. */
export function unreturnedPeerReplies<T extends Message>(
  transcript: FoldedTranscript<T>,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  const receipts = new Map<string, Map<string, Map<string, number>>>();
  for (const message of transcript.messages) {
    if (!message.runId) continue;
    for (const block of message.blocks) {
      if (block.kind !== "bot_message_sent") continue;
      let peers = receipts.get(message.runId);
      if (!peers) {
        peers = new Map();
        receipts.set(message.runId, peers);
      }
      let counts = peers.get(block.toBotId);
      if (!counts) {
        counts = new Map();
        peers.set(block.toBotId, counts);
      }
      const text = clampBotMessage(block.text);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  for (const marker of transcript.messages) {
    const peer = peerReceipt(marker.blocks);
    const replies = transcript.folded.get(marker.id);
    if (!peer || !replies) continue;
    const echoes = marker.runId ? receipts.get(marker.runId)?.get(peer.peerBotId) : undefined;
    result.set(
      marker.id,
      replies.filter((reply) => {
        if (reply.role !== "bot") return false;
        const content = reply.blocks.filter(isPeerReplyBlock);
        if (!content.length) return false;
        // Attachments are not represented by a text echo.
        if (content.some((b) => b.kind !== "text")) return true;
        const text = clampBotMessage(
          content.map((b) => (b.kind === "text" ? b.text : "")).join("\n"),
        );
        const count = echoes?.get(text) ?? 0;
        if (!count) return true;
        echoes?.set(text, count - 1);
        return false;
      }),
    );
  }
  return result;
}

/** Project only visible rows; callers remove invisible tool/reaction rows before grouping. */
export function peerExchangeLines<T extends Message>(transcript: FoldedTranscript<T>) {
  const lines = new Map<string, PeerExchange>();
  const lineOf = new Map<string, string>();
  const unreturned = unreturnedPeerReplies(transcript);
  let previous: PeerExchange | undefined;
  let firstId: string | undefined;
  for (const message of transcript.messages) {
    const receipt = peerReceipt(message.blocks);
    if (!receipt) {
      previous = undefined;
      continue;
    }
    const count =
      message.blocks.filter(
        (b) => b.kind === "bot_message_sent" || b.kind === "bot_message_received",
      ).length + (unreturned.get(message.id)?.length ?? 0);
    if (previous?.peerBotId === receipt.peerBotId && firstId) {
      previous.peerBotName = receipt.peerBotName;
      previous.count += count;
    } else {
      firstId = message.id;
      previous = { ...receipt, count };
      lines.set(firstId, previous);
    }
    lineOf.set(message.id, firstId);
  }
  return { lines, lineOf };
}

/** The final translation decides avatar placement, including locales with trailing words. */
export function splitPeerLabel(label: string, peerName: string) {
  const index = peerName ? label.lastIndexOf(peerName) : -1;
  return index < 0
    ? { before: "", name: "", after: label }
    : {
        before: label.slice(0, index),
        name: peerName,
        after: label.slice(index + peerName.length),
      };
}
