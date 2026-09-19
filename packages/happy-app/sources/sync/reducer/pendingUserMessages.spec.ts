import { describe, it, expect } from 'vitest';
import { NormalizedMessage, normalizeRawMessage } from '../typesRaw';
import { createReducer, reducer, ReducerOptions, registerUserMessageServerIds } from './reducer';
import { Message, messageSortKey, isOtherParticipantMessage } from '../typesMessage';
import { buildAgentTurnCopyTextByMessageId } from '../../utils/agentTurnCopy';

/**
 * A message this device just sent, shown before the server has it. The reducer
 * recognises it by its id being its own local id — no other path produces that.
 */
function optimistic(localId: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id: localId,
        localId,
        createdAt,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false,
    };
}

/** The same message coming back from the server, now carrying its server id. */
function echo(serverId: string, localId: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id: serverId,
        localId,
        createdAt,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false,
    };
}

/** The daemon's receipt: the agent has taken the message named by `ref` into context. */
function receipt(id: string, ref: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: { type: 'user-message-accepted', ref },
        isSidechain: false,
    };
}

function agentText(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text, uuid: id, parentUUID: null }],
    };
}

const HOLD: ReducerOptions = { holdUserMessagesUntilAccepted: true };

function userMessages(messages: Message[]) {
    return messages.filter((message) => message.kind === 'user-text');
}

describe('pending user messages', () => {
    it.each([false, true])('preserves the send-time queue display decision through history and acceptance (%s)', (queuedWhileBusy) => {
        const state = createReducer();
        const restored = normalizeRawMessage('server-1', 'local-1', 1000, {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { expectsAcceptance: true, queuedWhileBusy },
        });
        const [pending] = reducer(state, [restored!], null, HOLD).messages;
        expect(pending).toMatchObject({ pending: true, meta: { queuedWhileBusy } });

        const [settled] = reducer(state, [receipt('accepted:1', 'server-1', 2000)], null, HOLD).messages;
        expect(settled).not.toHaveProperty('pending');
        expect(settled.meta?.queuedWhileBusy).toBe(queuedWhileBusy);
    });

    it.each(['receipt-first', 'message-first'] as const)('keeps a rejected message failed across reload (%s)', (delivery) => {
        const failed = normalizeRawMessage('relay-refusal', 'rig:refused:server-1', 3000, {
            role: 'session',
            content: {
                id: 'refused:server-1', time: 3000, role: 'agent',
                ev: { t: 'user-message-rejected', ref: 'server-1', reason: 'That model is not available.' },
            },
            meta: { sentFrom: 'rig' },
        } as any);
        expect(failed).not.toBeNull();
        const sent = { ...echo('server-1', 'local-1', 'try this', 1000), meta: { expectsAcceptance: true } };
        const state = createReducer();
        const visible = new Map<string, Message>();
        const batches = delivery === 'receipt-first' ? [[failed!], [sent]] : [[sent], [failed!]];
        for (const batch of batches) {
            for (const row of reducer(state, batch, null, HOLD).messages) visible.set(row.id, row);
        }
        const [row] = [...visible.values()];
        expect(visible.size).toBe(1);
        expect(row).toMatchObject({ kind: 'user-text', createdAt: 1000, sortAt: 3000, sendError: 'That model is not available.' });
        expect(row).not.toHaveProperty('pending');
        const answer: Message = { kind: 'agent-text', id: 'old-answer', localId: null, createdAt: 2000, text: 'still working' };
        expect(buildAgentTurnCopyTextByMessageId([row, answer], { currentTurnComplete: false }).size).toBe(0);
        const today: Message = { ...answer, id: 'today', createdAt: 4000 };
        expect([row, today].sort((a, b) => messageSortKey(b) - messageSortKey(a)).map((message) => message.id))
            .toEqual(['today', row.id]);
    });

    it('holds a just-sent message and parks it below everything else', () => {
        const state = createReducer();

        const result = reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);

        const [message] = userMessages(result.messages);
        expect(message.kind === 'user-text' && message.pending).toBe(true);
        expect(messageSortKey(message)).toBeGreaterThan(Date.now());
        // The timestamp itself is untouched — only where it sits changes.
        expect(message.createdAt).toBe(1000);
    });

    it('commits immediately in a session that never reports acceptance', () => {
        const state = createReducer();

        const result = reducer(state, [optimistic('local-1', 'hello', 1000)]);

        const [message] = userMessages(result.messages);
        expect(message.kind === 'user-text' && message.pending).toBeUndefined();
        expect(messageSortKey(message)).toBe(1000);
    });

    it('releases the message when its receipt arrives, at the receipt position', () => {
        const state = createReducer();

        reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        reducer(state, [echo('server-1', 'local-1', 'steer me', 1000)], null, HOLD);
        const released = reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);

        const [message] = userMessages(released.messages);
        expect(message.kind === 'user-text' && message.pending).toBeFalsy();
        expect(messageSortKey(message)).toBe(5000);
        expect(message.createdAt).toBe(1000);
    });

    it('releases the message when the receipt outruns the server echo', () => {
        const state = createReducer();

        reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        const early = reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);
        expect(early.messages).toHaveLength(0);

        const released = reducer(state, [echo('server-1', 'local-1', 'steer me', 1000)], null, HOLD);

        const [message] = userMessages(released.messages);
        expect(message.kind === 'user-text' && message.pending).toBeFalsy();
        expect(messageSortKey(message)).toBe(5000);
    });

    it('renders nothing for the receipt itself', () => {
        const state = createReducer();

        reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        reducer(state, [echo('server-1', 'local-1', 'steer me', 1000)], null, HOLD);
        const released = reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);

        expect(released.messages.every((message) => message.kind === 'user-text')).toBe(true);
        expect(released.messages).toHaveLength(1);
    });

    it('ignores a receipt for a message this device never sent', () => {
        const state = createReducer();

        const result = reducer(state, [receipt('accepted:9', 'server-from-laptop', 5000)], null, HOLD);

        expect(result.messages).toHaveLength(0);
    });

    it('keeps the interrupted turn above the message and the new turn below it', () => {
        const state = createReducer();
        const collected = new Map<string, Message>();
        const collect = (messages: Message[]) => {
            for (const message of messages) collected.set(message.id, message);
        };

        collect(reducer(state, [agentText('a1', 'thinking about the old question', 1000)], null, HOLD).messages);
        collect(reducer(state, [optimistic('local-1', 'actually, do this instead', 2000)], null, HOLD).messages);
        // The turn that had not seen the message keeps streaming while it waits.
        collect(reducer(state, [agentText('a2', 'still answering the old question', 3000)], null, HOLD).messages);
        collect(reducer(state, [echo('server-1', 'local-1', 'actually, do this instead', 2000)], null, HOLD).messages);
        collect(reducer(state, [receipt('accepted:1', 'server-1', 4000)], null, HOLD).messages);
        collect(reducer(state, [agentText('a3', 'on the new instruction now', 5000)], null, HOLD).messages);

        const order = [...collected.values()]
            .sort((a, b) => messageSortKey(a) - messageSortKey(b))
            .map((message) => (message.kind === 'user-text' ? 'USER' : (message.kind === 'agent-text' ? message.text : message.kind)));

        expect(order).toEqual([
            'thinking about the old question',
            'still answering the old question',
            'USER',
            'on the new instruction now',
        ]);
    });

    it('never holds a message replayed from history', () => {
        const state = createReducer();

        // History rows arrive under a server id that is not the local id, so they
        // are somebody's settled past, not this device's unsent present.
        const result = reducer(state, [echo('server-7', 'local-7', 'from last week', 1000)], null, HOLD);

        const [message] = userMessages(result.messages);
        expect(message.kind === 'user-text' && message.pending).toBeUndefined();
        expect(messageSortKey(message)).toBe(1000);
    });

    it('restores pending state only for history sent with acceptance receipts enabled', () => {
        const state = createReducer();
        const restored = normalizeRawMessage('server-1', 'local-1', 1000, {
            role: 'user',
            content: { type: 'text', text: 'still waiting' },
            meta: { expectsAcceptance: true },
        });
        expect(restored?.meta?.expectsAcceptance).toBe(true);
        const result = reducer(state, [restored!, agentText('tail', 'older turn', 2000)], null, HOLD);
        const rows = result.messages.sort((a, b) => messageSortKey(b) - messageSortKey(a));
        expect(rows[0]).toMatchObject({ kind: 'user-text', pending: true, text: 'still waiting' });
        const settled = reducer(state, [receipt('accepted:1', 'server-1', 3000)], null, HOLD);
        expect(settled.messages[0]).not.toHaveProperty('pending');
        expect(messageSortKey(settled.messages[0])).toBe(3000);

        const legacy = reducer(createReducer(), [restored!]);
        expect(legacy.messages[0]).not.toHaveProperty('pending');
    });

    it.each(['receipt-first', 'ack-first', 'same-batch'] as const)(
        'keeps messages in receipt timestamp order (%s)',
        (delivery) => {
            const state = createReducer();
            const visible = new Map<string, Message>();
            const collect = (messages: Message[]) => messages.forEach((message) => visible.set(message.id, message));
            const local = optimistic('local-1', 'steer', 1000);
            const accepted = receipt('accepted:1', 'server-1', 3000);
            const tail = { ...agentText('tail', 'old tail', 2000), turn: 'old' };
            const answer = { ...agentText('answer', 'new answer', 4000), turn: 'new' };
            const ack = [{ serverId: 'server-1', localId: 'local-1' }];

            if (delivery === 'receipt-first') {
                collect(reducer(state, [accepted], null, HOLD).messages);
                registerUserMessageServerIds(state, ack);
                collect(reducer(state, [local, tail, answer], null, HOLD).messages);
            } else if (delivery === 'ack-first') {
                collect(reducer(state, [local, tail], null, HOLD).messages);
                registerUserMessageServerIds(state, ack);
                collect(reducer(state, [accepted, answer], null, HOLD).messages);
            } else {
                collect(reducer(state, [local, echo('server-1', 'local-1', 'steer', 1000), tail, accepted, answer], null, HOLD).messages);
            }

            const rows = [...visible.values()].sort((a, b) => messageSortKey(b) - messageSortKey(a));
            expect(rows.map((message) => 'text' in message ? message.text : '').reverse())
                .toEqual(['old tail', 'steer', 'new answer']);
            expect(rows[1]).toMatchObject({ sortAt: 3000 });
            expect(buildAgentTurnCopyTextByMessageId(rows, { currentTurnComplete: false }).has(rows[0].id)).toBe(false);
        },
    );

    it('settles from the receipt the daemon actually puts on the wire', () => {
        // Byte-for-byte the envelope mapHappyMessages emits: no `turn`, agent role,
        // a `rig:`-prefixed localId, and a ref naming the phone's own server message.
        const wire = normalizeRawMessage('server-receipt-1', 'rig:accepted:msg-1', 4000, {
            role: 'session',
            content: {
                id: 'accepted:msg-1',
                time: 4000,
                role: 'agent',
                ev: {
                    t: 'user-message-accepted',
                    id: 'msg-1',
                    ref: 'server-1',
                    runId: 'run-1'
                }
            },
            meta: { sentFrom: 'rig' }
        } as any);

        expect(wire).not.toBeNull();

        const state = createReducer();
        reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        reducer(state, [echo('server-1', 'local-1', 'steer me', 1000)], null, HOLD);
        const released = reducer(state, [wire!], null, HOLD);

        const [message] = userMessages(released.messages);
        expect(message.kind === 'user-text' && message.pending).toBeFalsy();
        expect(messageSortKey(message)).toBe(4000);
    });

    it('settles through the send ack when the socket echo never arrives', () => {
        // The ack watermark lets the transport skip our own echo, so the
        // POST response is the only guaranteed sighting of the server id.
        const state = createReducer();

        reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        const settled = registerUserMessageServerIds(state, [{ serverId: 'server-1', localId: 'local-1' }]);
        expect(settled).toHaveLength(0); // join recorded; nothing to re-render yet

        const released = reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);
        const [message] = userMessages(released.messages);
        expect(message.kind === 'user-text' && message.pending).toBeFalsy();
        expect(messageSortKey(message)).toBe(5000);
    });

    it('keeps an ack that outran the optimistic insert until the row exists', () => {
        // flushOutbox runs outside the session message lock, so the ack can
        // beat the queued optimistic reduction.
        const state = createReducer();

        registerUserMessageServerIds(state, [{ serverId: 'server-1', localId: 'local-1' }]);
        reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);
        const inserted = reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);

        const [message] = userMessages(inserted.messages);
        expect(message.kind === 'user-text' && message.pending).toBeFalsy();
        expect(messageSortKey(message)).toBe(5000);
    });

    it('gives a replayed message its run-order place on a fresh reload', () => {
        // After a restart nothing is pending, but the receipt still travels the
        // stream: the transcript must read the same as it did live.
        const state = createReducer();

        const result = reducer(state, [
            agentText('a1', 'old turn tail', 3000),
            echo('server-1', 'local-1', 'steer me', 1000),
            receipt('accepted:1', 'server-1', 4000),
            agentText('a3', 'new turn', 5000),
        ], null, HOLD);

        const order = result.messages
            .sort((a, b) => messageSortKey(a) - messageSortKey(b))
            .map((message) => (message.kind === 'user-text' ? 'USER' : (message.kind === 'agent-text' ? message.text : message.kind)));
        expect(order).toEqual(['old turn tail', 'USER', 'new turn']);
    });

    it('never repositions a message twice', () => {
        const state = createReducer();

        reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        reducer(state, [echo('server-1', 'local-1', 'steer me', 1000)], null, HOLD);
        reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);
        // A replayed duplicate of the receipt must not move the settled row.
        const replay = reducer(state, [receipt('accepted:replay', 'server-1', 9000)], null, HOLD);

        expect(replay.messages).toHaveLength(0);
        expect(state.pendingReceipts.has('server-1')).toBe(false);
    });

    it('reports settle-only changes so they are not announced as new', () => {
        const state = createReducer();

        const insert = reducer(state, [optimistic('local-1', 'steer me', 1000)], null, HOLD);
        expect(insert.settledMessageIds).toBeUndefined();

        reducer(state, [echo('server-1', 'local-1', 'steer me', 1000)], null, HOLD);
        const released = reducer(state, [receipt('accepted:1', 'server-1', 5000)], null, HOLD);
        expect(released.settledMessageIds).toEqual([released.messages[0].id]);
    });

    it('holds each pending message in the order it was sent', () => {
        const state = createReducer();

        const first = reducer(state, [optimistic('local-1', 'first', 1000)], null, HOLD);
        const second = reducer(state, [optimistic('local-2', 'second', 2000)], null, HOLD);

        expect(messageSortKey(second.messages[0])).toBeGreaterThan(messageSortKey(first.messages[0]));
    });
});

describe('participants and turns', () => {
    it('treats only an attributed non-owner as another participant', () => {
        expect(isOtherParticipantMessage({})).toBe(false);
        expect(isOtherParticipantMessage({ author: { id: 'owner', name: 'You', owner: true } })).toBe(false);
        expect(isOtherParticipantMessage({ author: { id: 'other', name: 'Alex', owner: false } })).toBe(true);
    });

    it('never holds another participant\'s message: the daemon publishes it at acceptance', () => {
        // A message typed on the desktop reaches this device from the daemon,
        // already in run order and under a server id, with the sender attached.
        const state = createReducer();

        const result = reducer(state, [{
            id: 'server-3',
            localId: null,
            createdAt: 3000,
            role: 'user',
            content: { type: 'text', text: 'ship it' },
            isSidechain: false,
            author: { id: 'user-2', name: 'Alex', owner: false },
        }], null, HOLD);

        const [message] = userMessages(result.messages);
        expect(message.kind === 'user-text' && message.pending).toBeFalsy();
        expect(messageSortKey(message)).toBe(3000);
        expect(message.kind === 'user-text' && message.author).toEqual({ id: 'user-2', name: 'Alex', owner: false });
    });

    it('carries the turn id onto agent text, tool and event rows', () => {
        const state = createReducer();

        const result = reducer(state, [
            { ...agentText('a1', 'looking', 1000), turn: 'turn-a' },
            {
                id: 'a2',
                localId: null,
                createdAt: 1001,
                role: 'agent',
                isSidechain: false,
                turn: 'turn-a',
                content: [{ type: 'tool-call', id: 'call-1', name: 'Read', input: {}, description: null, uuid: 'a2', parentUUID: null }],
            },
            {
                id: 'a3',
                localId: null,
                createdAt: 1002,
                role: 'event',
                isSidechain: false,
                turn: 'turn-a',
                content: { type: 'switch', mode: 'remote' },
            },
        ]);

        expect(result.messages).toHaveLength(3);
        expect(result.messages.map((message) => message.kind).sort()).toEqual(['agent-event', 'agent-text', 'tool-call']);
        expect(result.messages.map((message) => (message.kind === 'user-text' ? undefined : message.turn)))
            .toEqual(['turn-a', 'turn-a', 'turn-a']);
    });

    it('takes the turn id from the tool-call-start that fills a permission placeholder', () => {
        const state = createReducer();

        // The permission request arrives through agentState with no turn.
        const placeholder = reducer(state, [], {
            controlledByUser: false,
            requests: {
                'call-1': { tool: 'Read', arguments: {}, createdAt: 900 },
            },
        });
        const [row] = placeholder.messages;
        expect(row.kind === 'tool-call' && row.turn).toBeUndefined();

        const filled = reducer(state, [{
            id: 'a2',
            localId: null,
            createdAt: 1001,
            role: 'agent',
            isSidechain: false,
            turn: 'turn-a',
            content: [{ type: 'tool-call', id: 'call-1', name: 'Read', input: {}, description: null, uuid: 'a2', parentUUID: null }],
        }]);

        const [updated] = filled.messages;
        expect(updated.id).toBe(row.id);
        expect(updated.kind === 'tool-call' && updated.turn).toBe('turn-a');
    });
});
