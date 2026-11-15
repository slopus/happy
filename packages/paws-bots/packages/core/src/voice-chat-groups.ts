import type { MessageBlock } from "@rakazo/contracts";
import { speechFromBlocks } from "./speech-text.js";

/** The fields grouping reads; web `ThreadMessage` and mobile `MobileMessage` both satisfy it. */
export type VoiceChatMessage = {
  id: string;
  role: string;
  runId?: string;
  callId?: string;
  createdAt?: string;
  blocks: MessageBlock[];
};

export type VoiceChatGroup<T extends VoiceChatMessage = VoiceChatMessage> = {
  kind: "voiceChat";
  /**
   * List key: `call:<callId>` for a call's first group, `call:<callId>:<n>` for the
   * later segments a typed message split it into. Keying off the first message would
   * change when an older page extends a segment, remounting the card.
   */
  key: string;
  callId: string;
  messages: T[];
  /** The `voice_call` message the bot left when it hung up; it closes the group. */
  marker?: T;
};
export type ThreadItem<T extends VoiceChatMessage = VoiceChatMessage> =
  | { kind: "message"; message: T }
  | VoiceChatGroup<T>;

const SUMMARY_MAX = 120;

/**
 * Collapses each run of consecutive call messages into one group: a user
 * message carrying the call's `callId`, or a bot reply to a run already in the
 * group. Anything else ends the run — a typed user message breaks the group
 * even when it reuses the run of a call turn. The bot's `voice_call` marker
 * closes the group, so the work it does after hanging up renders as chat.
 */
export function groupVoiceChats<T extends VoiceChatMessage>(messages: T[]): ThreadItem<T>[] {
  const items: ThreadItem<T>[] = [];
  let open: VoiceChatGroup<T> | undefined;
  let openRunIds = new Set<string>();
  const segments = new Map<string, number>();
  for (const message of messages) {
    if (open) {
      const joinsByRun = Boolean(
        message.role === "bot" && message.runId && openRunIds.has(message.runId),
      );
      if (message.callId === open.callId || joinsByRun) {
        open.messages.push(message);
        if (isCallMarker(message)) {
          open.marker = message;
          open = undefined;
          continue;
        }
        if (
          message.callId === open.callId &&
          message.runId &&
          message.blocks[0]?.kind !== "call_request"
        )
          openRunIds.add(message.runId);
        continue;
      }
      open = undefined;
    }
    if (message.callId) {
      const segment = (segments.get(message.callId) ?? 0) + 1;
      segments.set(message.callId, segment);
      open = {
        kind: "voiceChat",
        key: segment === 1 ? `call:${message.callId}` : `call:${message.callId}:${segment}`,
        callId: message.callId,
        messages: [message],
      };
      // A request belongs to the calling run, not to a spoken turn.
      openRunIds = new Set(
        message.runId && message.blocks[0]?.kind !== "call_request" ? [message.runId] : [],
      );
      items.push(open);
      if (isCallMarker(message)) {
        open.marker = message;
        open = undefined;
      }
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

/** Newest bot turn still inside this call's open card. Typed turns and wrap-up sit outside. */
export function latestSpokenCallReply<T extends VoiceChatMessage>(
  messages: T[],
  callId: string,
): T | undefined {
  const groups = groupVoiceChats(messages).filter(
    (item): item is VoiceChatGroup<T> => item.kind === "voiceChat" && item.callId === callId,
  );
  const group = groups.at(-1);
  if (!group || group.marker) return undefined;
  for (let index = group.messages.length - 1; index >= 0; index -= 1) {
    const message = group.messages[index];
    if (message?.role === "bot") return message;
  }
  return undefined;
}

function isCallMarker(message: VoiceChatMessage): boolean {
  return message.role === "bot" && message.blocks[0]?.kind === "voice_call";
}

/** The title the bot hung up with, else the first sentence of its first spoken reply. */
export function voiceChatSummary(group: VoiceChatGroup): string {
  const marker = group.marker?.blocks[0];
  const title = marker?.kind === "voice_call" ? marker.title.trim() : "";
  if (title) return title;
  let spoken = "";
  for (const message of group.messages) {
    if (message.role !== "bot" || message === group.marker) continue;
    spoken = speechFromBlocks(message.blocks).trim();
    if (spoken) break;
  }
  if (!spoken) return "";
  const end = spoken.search(/[.!?](\s|$)/u);
  const sentence = end === -1 ? spoken : spoken.slice(0, end + 1);
  return sentence.length > SUMMARY_MAX
    ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : sentence;
}

/** The connected time the caller recorded, else whole seconds between the first and last message. */
export function voiceChatDuration(group: VoiceChatGroup): number {
  const marker = group.marker?.blocks[0];
  if (marker?.kind === "voice_call" && marker.durationSeconds !== undefined) {
    return marker.durationSeconds;
  }
  const request = group.messages[0]?.blocks[0];
  if (request?.kind === "call_request" && request.durationSeconds !== undefined) {
    return request.durationSeconds;
  }
  const first = group.messages[0];
  const last = group.messages[group.messages.length - 1];
  if (!first || !last) return 0;
  const seconds = (Date.parse(last.createdAt ?? "") - Date.parse(first.createdAt ?? "")) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}
