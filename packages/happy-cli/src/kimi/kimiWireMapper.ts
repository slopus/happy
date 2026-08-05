/**
 * Maps Kimi Code CLI `wire.jsonl` records to Happy session envelopes.
 *
 * Kimi persists every session under
 * `~/.kimi-code/sessions/<workspace>/<sessionId>/agents/main/wire.jsonl`,
 * appending one JSON record per event as the turn progresses. That file is the
 * only live view into a locally-running TUI, so the local mode tails it and
 * replays the records through this mapper — the same role
 * `sessionProtocolMapper.ts` plays for Claude's transcript JSONL.
 *
 * Only conversation-bearing records are mapped. In particular
 * `context.append_message` is deliberately ignored: it mirrors everything fed
 * into the model context, including injected `<system-reminder>` blocks, and
 * duplicates the user text already carried by `turn.prompt`.
 */

import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type SessionEnvelope, type SessionUsage } from '@slopus/happy-wire';

/** Wire protocol versions this mapper was written against. */
export const SUPPORTED_KIMI_WIRE_PROTOCOLS = ['1.4'];

export type KimiWireState = {
    /** Turn currently open on the wire, or null between turns. */
    currentTurnId: string | null;
    /** Tool calls already announced, so results without a start are dropped. */
    openToolCalls: Set<string>;
    /**
     * Usage reported by a finished step. `step.end` carries the token counts but
     * has no content of its own, so it rides along on the next envelope that can
     * carry usage rather than emitting an empty text row.
     */
    pendingUsage?: SessionUsage;
};

export function createKimiWireState(): KimiWireState {
    return { currentTurnId: null, openToolCalls: new Set<string>() };
}

/** Attach any usage left over from a `step.end` to the first envelope that can carry it. */
function applyPendingUsage(state: KimiWireState, envelopes: SessionEnvelope[]): void {
    if (!state.pendingUsage) {
        return;
    }
    for (let i = 0; i < envelopes.length; i += 1) {
        const t = envelopes[i].ev.t;
        if (t === 'turn-start' || t === 'turn-end' || t === 'start' || t === 'stop') {
            continue;
        }
        envelopes[i] = { ...envelopes[i], usage: state.pendingUsage };
        state.pendingUsage = undefined;
        return;
    }
}

/** Kimi reports token counts under its own names; normalise to the wire usage shape. */
function toSessionUsage(usage: unknown): SessionUsage | undefined {
    if (!usage || typeof usage !== 'object') {
        return undefined;
    }
    const raw = usage as Record<string, unknown>;
    const pick = (key: string): number | undefined => {
        const value = raw[key];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    };

    const input = pick('inputOther');
    const output = pick('output');
    if (input === undefined && output === undefined) {
        return undefined;
    }

    return {
        input_tokens: input ?? 0,
        output_tokens: output ?? 0,
        cache_read_input_tokens: pick('inputCacheRead'),
        cache_creation_input_tokens: pick('inputCacheCreation'),
    };
}

function textFromContentBlocks(input: unknown): string {
    if (!Array.isArray(input)) {
        return '';
    }
    return input
        .filter((block): block is { type: string; text: string } =>
            !!block && typeof block === 'object'
            && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string')
        .map((block) => block.text)
        .join('')
        .trim();
}

function ensureTurn(state: KimiWireState, envelopes: SessionEnvelope[]): string {
    if (state.currentTurnId) {
        return state.currentTurnId;
    }
    const turn = createId();
    envelopes.push(createEnvelope('agent', { t: 'turn-start' }, { turn }));
    state.currentTurnId = turn;
    return turn;
}

function closeTurn(
    state: KimiWireState,
    status: 'completed' | 'failed' | 'cancelled',
    envelopes: SessionEnvelope[],
): void {
    if (!state.currentTurnId) {
        return;
    }
    for (const call of state.openToolCalls) {
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, { turn: state.currentTurnId }));
    }
    state.openToolCalls.clear();
    envelopes.push(createEnvelope('agent', { t: 'turn-end', status }, { turn: state.currentTurnId }));
    state.currentTurnId = null;
}

/** Close whatever turn is open — used when the local Kimi process goes away. */
export function closeKimiTurn(
    state: KimiWireState,
    status: 'completed' | 'failed' | 'cancelled',
): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    closeTurn(state, status, envelopes);
    return envelopes;
}

function mapLoopEvent(event: Record<string, unknown>, state: KimiWireState): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    const type = event.type;

    if (type === 'step.begin') {
        ensureTurn(state, envelopes);
        return envelopes;
    }

    if (type === 'content.part') {
        const part = event.part as { type?: unknown; text?: unknown; think?: unknown } | undefined;
        if (!part) {
            return envelopes;
        }
        const turn = ensureTurn(state, envelopes);
        const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;

        if (part.type === 'think' && typeof part.think === 'string' && part.think.trim().length > 0) {
            envelopes.push(createEnvelope('agent', { t: 'text', text: part.think, thinking: true }, { turn, claudeUuid: uuid }));
            return envelopes;
        }
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
            envelopes.push(createEnvelope('agent', { t: 'text', text: part.text }, { turn, claudeUuid: uuid }));
        }
        return envelopes;
    }

    if (type === 'tool.call') {
        const call = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        if (!call) {
            return envelopes;
        }
        const turn = ensureTurn(state, envelopes);
        const name = typeof event.name === 'string' && event.name.length > 0 ? event.name : 'unknown';
        const description = typeof event.description === 'string' && event.description.trim().length > 0
            ? event.description.trim()
            : `${name} call`;
        const args = event.args && typeof event.args === 'object' && !Array.isArray(event.args)
            ? event.args as Record<string, unknown>
            : {};

        state.openToolCalls.add(call);
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-start',
            call,
            name,
            title: description,
            description,
            args,
        }, { turn }));
        return envelopes;
    }

    if (type === 'tool.result') {
        const call = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        // A result without a recorded start would render as an orphan row in the app.
        if (!call || !state.openToolCalls.has(call)) {
            return envelopes;
        }
        const turn = ensureTurn(state, envelopes);
        state.openToolCalls.delete(call);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, { turn }));
        return envelopes;
    }

    if (type === 'step.end') {
        const usage = toSessionUsage(event.usage);
        if (usage) {
            state.pendingUsage = usage;
        }
        // `tool_use` means the model is continuing the same turn after a tool
        // round-trip; only a terminal finish reason ends the turn.
        if (event.finishReason === 'end_turn') {
            closeTurn(state, 'completed', envelopes);
        }
        return envelopes;
    }

    return envelopes;
}

/**
 * Translate a single `wire.jsonl` record into session envelopes, mutating
 * `state` to track the open turn. Unknown record types map to nothing.
 */
export function mapKimiWireRecordToSessionEnvelopes(
    record: unknown,
    state: KimiWireState,
): SessionEnvelope[] {
    if (!record || typeof record !== 'object') {
        return [];
    }
    const raw = record as Record<string, unknown>;

    if (raw.type === 'turn.prompt') {
        const text = textFromContentBlocks(raw.input);
        if (text.length === 0) {
            return [];
        }
        const envelopes: SessionEnvelope[] = [];
        closeTurn(state, 'completed', envelopes);
        envelopes.push(createEnvelope('user', { t: 'text', text }));
        return envelopes;
    }

    if (raw.type === 'turn.cancel') {
        const envelopes: SessionEnvelope[] = [];
        closeTurn(state, 'cancelled', envelopes);
        return envelopes;
    }

    if (raw.type === 'context.append_loop_event') {
        const event = raw.event;
        if (!event || typeof event !== 'object') {
            return [];
        }
        const envelopes = mapLoopEvent(event as Record<string, unknown>, state);
        applyPendingUsage(state, envelopes);
        return envelopes;
    }

    return [];
}
