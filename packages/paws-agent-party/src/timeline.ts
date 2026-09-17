import type { Message as PartyMessage } from '../vendor/agents-party/src/core/types.js';

export type TimelineMessage = PartyMessage;

export type TimelineState = {
  receiveCursor: number;
  messages: TimelineMessage[];
};

export function initialTimeline(): TimelineState {
  return { receiveCursor: 0, messages: [] };
}

export function receivedBatch(state: TimelineState, batch: TimelineMessage[]): TimelineState {
  return {
    receiveCursor: batch.reduce((cursor, item) => Math.max(cursor, cursorNumber(item.cursor)), state.receiveCursor),
    messages: mergeMessages(state.messages, batch),
  };
}

export function ownSend(state: TimelineState, message: TimelineMessage): TimelineState {
  return { ...state, messages: mergeMessages(state.messages, [message]) };
}

function mergeMessages(current: TimelineMessage[], incoming: TimelineMessage[]): TimelineMessage[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => cursorNumber(left.cursor) - cursorNumber(right.cursor) || left.id.localeCompare(right.id));
}

function cursorNumber(cursor: string): number {
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
