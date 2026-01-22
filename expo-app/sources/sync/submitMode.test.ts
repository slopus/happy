import { describe, expect, it } from 'vitest';

import { chooseSubmitMode } from './submitMode';

describe('chooseSubmitMode', () => {
    it('preserves interrupt mode', () => {
        expect(chooseSubmitMode({
            configuredMode: 'interrupt',
            session: { metadata: {} } as any,
        })).toBe('interrupt');
    });

    it('preserves explicit server_pending mode', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            session: { metadata: {} } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending while controlledByUser when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                agentState: { controlledByUser: true },
                metadata: { messageQueueV1: { v: 1, queue: [] } },
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending while thinking when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                metadata: { messageQueueV1: { v: 1, queue: [] } },
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending when the session is offline but queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 0,
                agentStateVersion: 0,
                metadata: { messageQueueV1: { v: 1, queue: [] } },
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending when the agent is not ready but queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 'online',
                agentStateVersion: 0,
                metadata: { messageQueueV1: { v: 1, queue: [] } },
            } as any,
        })).toBe('server_pending');
    });

    it('keeps agent_queue if queue is not supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });
});
