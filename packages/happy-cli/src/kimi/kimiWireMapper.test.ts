import { describe, expect, it } from 'vitest';
import {
    closeKimiTurn,
    createKimiWireState,
    mapKimiWireRecordToSessionEnvelopes,
} from './kimiWireMapper';

/** Records below are trimmed copies of real `wire.jsonl` lines (protocol 1.4). */
const loopEvent = (event: Record<string, unknown>) => ({
    type: 'context.append_loop_event',
    event,
    time: 1785650277153,
});

describe('mapKimiWireRecordToSessionEnvelopes', () => {
    it('maps a user prompt to a user text envelope', () => {
        const state = createKimiWireState();
        const envelopes = mapKimiWireRecordToSessionEnvelopes({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'Continue de onde parou' }],
        }, state);

        expect(envelopes).toHaveLength(1);
        expect(envelopes[0].role).toBe('user');
        expect(envelopes[0].ev).toEqual({ t: 'text', text: 'Continue de onde parou' });
    });

    it('ignores context.append_message so injected system reminders never reach the chat', () => {
        const state = createKimiWireState();
        const envelopes = mapKimiWireRecordToSessionEnvelopes({
            type: 'context.append_message',
            message: {
                role: 'user',
                content: [{ type: 'text', text: '<system-reminder>\nThe TodoList tool has not been updated\n</system-reminder>' }],
            },
        }, state);

        expect(envelopes).toEqual([]);
    });

    it('opens a turn on step.begin and maps thinking and text parts', () => {
        const state = createKimiWireState();

        const begin = mapKimiWireRecordToSessionEnvelopes(
            loopEvent({ type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 }),
            state,
        );
        expect(begin).toHaveLength(1);
        expect(begin[0].ev).toEqual({ t: 'turn-start' });
        const turn = begin[0].turn;
        expect(turn).toBeTruthy();

        const thinking = mapKimiWireRecordToSessionEnvelopes(
            loopEvent({ type: 'content.part', uuid: 'p1', part: { type: 'think', think: 'Let me understand' } }),
            state,
        );
        expect(thinking[0].ev).toEqual({ t: 'text', text: 'Let me understand', thinking: true });
        expect(thinking[0].turn).toBe(turn);

        const text = mapKimiWireRecordToSessionEnvelopes(
            loopEvent({ type: 'content.part', uuid: 'p2', part: { type: 'text', text: 'Pronto.' } }),
            state,
        );
        expect(text[0].ev).toEqual({ t: 'text', text: 'Pronto.' });
        expect(text[0].turn).toBe(turn);
    });

    it('pairs tool calls with their results', () => {
        const state = createKimiWireState();
        mapKimiWireRecordToSessionEnvelopes(loopEvent({ type: 'step.begin', turnId: '0', step: 1 }), state);

        const call = mapKimiWireRecordToSessionEnvelopes(loopEvent({
            type: 'tool.call',
            toolCallId: 'tool_abc',
            name: 'Bash',
            args: { command: 'ls' },
            description: 'Running: ls',
        }), state);
        expect(call[0].ev).toEqual({
            t: 'tool-call-start',
            call: 'tool_abc',
            name: 'Bash',
            title: 'Running: ls',
            description: 'Running: ls',
            args: { command: 'ls' },
        });

        const result = mapKimiWireRecordToSessionEnvelopes(loopEvent({
            type: 'tool.result',
            toolCallId: 'tool_abc',
            result: { output: 'a\nb' },
        }), state);
        expect(result[0].ev).toEqual({ t: 'tool-call-end', call: 'tool_abc' });
    });

    it('drops a tool result that has no matching call', () => {
        const state = createKimiWireState();
        const envelopes = mapKimiWireRecordToSessionEnvelopes(
            loopEvent({ type: 'tool.result', toolCallId: 'unknown', result: {} }),
            state,
        );
        expect(envelopes).toEqual([]);
    });

    it('keeps the turn open across tool_use steps and closes it on end_turn', () => {
        const state = createKimiWireState();
        mapKimiWireRecordToSessionEnvelopes(loopEvent({ type: 'step.begin', turnId: '0', step: 1 }), state);

        const midTurn = mapKimiWireRecordToSessionEnvelopes(loopEvent({
            type: 'step.end',
            finishReason: 'tool_use',
            usage: { inputOther: 3213, output: 512, inputCacheRead: 19200, inputCacheCreation: 0 },
        }), state);
        expect(midTurn).toEqual([]);
        expect(state.currentTurnId).not.toBeNull();

        const closing = mapKimiWireRecordToSessionEnvelopes(loopEvent({
            type: 'step.end',
            finishReason: 'end_turn',
            usage: { inputOther: 10, output: 20 },
        }), state);
        expect(closing.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'completed' });
        expect(state.currentTurnId).toBeNull();
    });

    it('carries step usage on the next content envelope instead of an empty row', () => {
        const state = createKimiWireState();
        mapKimiWireRecordToSessionEnvelopes(loopEvent({ type: 'step.begin', turnId: '0', step: 1 }), state);
        mapKimiWireRecordToSessionEnvelopes(loopEvent({
            type: 'step.end',
            finishReason: 'tool_use',
            usage: { inputOther: 3213, output: 512, inputCacheRead: 19200, inputCacheCreation: 0 },
        }), state);

        const next = mapKimiWireRecordToSessionEnvelopes(
            loopEvent({ type: 'content.part', part: { type: 'text', text: 'ok' } }),
            state,
        );
        expect(next[0].usage).toEqual({
            input_tokens: 3213,
            output_tokens: 512,
            cache_read_input_tokens: 19200,
            cache_creation_input_tokens: 0,
        });
        expect(state.pendingUsage).toBeUndefined();
    });

    it('closes the open turn as cancelled on turn.cancel and ends dangling tool calls', () => {
        const state = createKimiWireState();
        mapKimiWireRecordToSessionEnvelopes(loopEvent({ type: 'step.begin', turnId: '0', step: 1 }), state);
        mapKimiWireRecordToSessionEnvelopes(loopEvent({
            type: 'tool.call', toolCallId: 'tool_open', name: 'Bash', args: {},
        }), state);

        const envelopes = mapKimiWireRecordToSessionEnvelopes({ type: 'turn.cancel' }, state);
        expect(envelopes.map((e) => e.ev.t)).toEqual(['tool-call-end', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });

    it('starts a new turn when a prompt arrives while one is still open', () => {
        const state = createKimiWireState();
        mapKimiWireRecordToSessionEnvelopes(loopEvent({ type: 'step.begin', turnId: '0', step: 1 }), state);

        const envelopes = mapKimiWireRecordToSessionEnvelopes({
            type: 'turn.prompt',
            input: [{ type: 'text', text: 'Continue' }],
        }, state);

        expect(envelopes.map((e) => e.ev.t)).toEqual(['turn-end', 'text']);
        expect(state.currentTurnId).toBeNull();
    });

    it('ignores bookkeeping records that carry no conversation', () => {
        const state = createKimiWireState();
        for (const record of [
            { type: 'metadata', protocol_version: '1.4' },
            { type: 'config.update', modelAlias: 'kimi-code/k3' },
            { type: 'tools.set_active_tools', names: ['Read'] },
            { type: 'llm.request', model: 'k3' },
            { type: 'usage.record', usage: { output: 1 } },
            { type: 'permission.set_mode', mode: 'yolo' },
        ]) {
            expect(mapKimiWireRecordToSessionEnvelopes(record, state)).toEqual([]);
        }
    });

    it('closeKimiTurn ends an interrupted turn', () => {
        const state = createKimiWireState();
        mapKimiWireRecordToSessionEnvelopes(loopEvent({ type: 'step.begin', turnId: '0', step: 1 }), state);

        expect(closeKimiTurn(state, 'failed').at(-1)?.ev).toEqual({ t: 'turn-end', status: 'failed' });
        expect(closeKimiTurn(state, 'failed')).toEqual([]);
    });
});
