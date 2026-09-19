import { AgentEvent, SessionAuthor } from "./typesRaw";
import { MessageMeta } from "./typesMessageMeta";

export type ToolCall = {
    /** Provider/session-protocol tool-call id used to join side-channel UI state. */
    callId?: string;
    name: string;
    /** Human-readable title supplied by the session protocol. */
    title?: string;
    state: 'running' | 'completed' | 'error';
    input: any;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: any;
    permission?: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        date?: number;
    };
}

// Flattened message types - each message represents a single block
export type UserTextMessage = {
    kind: 'user-text';
    id: string;
    localId: string | null;
    createdAt: number;
    text: string;
    displayText?: string; // Optional text to display in UI instead of actual text
    meta?: MessageMeta;
    /**
     * Claude conversation-file `uuid` corresponding to this message. Used as
     * the rewind point when forking / duplicating a session. Optional —
     * older messages and non-Claude agents may not have one.
     */
    claudeUuid?: string;
    /**
     * Codex app-server item id corresponding to this user message. Used as
     * the rewind point when duplicating/forking Codex threads.
     */
    codexItemId?: string;
    /**
     * Sent, but the agent has not taken it into context yet. Pinned to the
     * bottom until an acceptance receipt arrives, so a turn that has not seen
     * this message still streams above it. meta.queuedWhileBusy sends are faded
     * and labelled at once; other pending sends get a short visual grace period.
     */
    pending?: boolean;
    /** Terminal refusal from the daemon; this message never started a turn. */
    sendError?: string;
    /**
     * Position in the chat, when that differs from when the message was made.
     * `createdAt` is immutable by reducer contract, and a pending message has
     * to sit below newer rows, so ordering reads this and falls back to
     * `createdAt` for every message that never waited.
     */
    sortAt?: number;
    /**
     * Who sent this message, for Happy sessions with more than one participant.
     * Absent on this account's own messages from daemons that predate it, so
     * "no author" and "author.owner" both render as the reader's own bubble.
     */
    author?: SessionAuthor;
}

export type ModeSwitchMessage = {
    kind: 'agent-event';
    id: string;
    createdAt: number;
    turn?: string;
    event: AgentEvent;
    meta?: MessageMeta;
}

export type AgentTextMessage = {
    kind: 'agent-text';
    id: string;
    localId: string | null;
    createdAt: number;
    turn?: string;
    text: string;
    isThinking?: boolean;
    meta?: MessageMeta;
}

export type ToolCallMessage = {
    kind: 'tool-call';
    id: string;
    localId: string | null;
    createdAt: number;
    turn?: string;
    tool: ToolCall;
    children: Message[];
    meta?: MessageMeta;
}

/** True for a user message that was not sent from this account. */
export function isOtherParticipantMessage(message: Pick<UserTextMessage, 'author'>): boolean {
    return message.author !== undefined && message.author.owner !== true;
}

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage;

/**
 * Added to a pending message's own timestamp to park it past every real one,
 * which keeps pending messages at the bottom of the chat and in send order
 * among themselves. Far enough above wall-clock milliseconds to never collide,
 * far enough below Number.MAX_SAFE_INTEGER to stay exact.
 */
export const PENDING_SORT_OFFSET = 8_000_000_000_000_000;

/** Where a message sits in the chat: its settled position, or when it was made. */
export function messageSortKey(message: Message): number {
    if (message.kind === 'user-text' && message.sortAt !== undefined) {
        return message.sortAt;
    }
    return message.createdAt;
}
