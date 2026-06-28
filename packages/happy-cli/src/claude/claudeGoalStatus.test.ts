import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    claudeGoalActionCapabilities,
    mapClaudeGoalStatusEventToAgentGoalStatus,
    parseClaudeGoalActionParams,
    parseClaudeGoalStatusTranscriptEvent,
    reduceClaudeGoalStatusEvents,
} from './claudeGoalStatus';

function fixture(name: string): unknown {
    const raw = readFileSync(join(__dirname, '__fixtures__', 'goal-status', name), 'utf8').trim();
    return JSON.parse(raw);
}

describe('parseClaudeGoalStatusTranscriptEvent', () => {
    it('accepts raw Claude goal_status transcript attachments', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));

        expect(event).toMatchObject({
            type: 'goal_status',
            uuid: expect.any(String),
            sourceSessionId: expect.any(String),
            attachment: {
                type: 'goal_status',
                met: false,
                sentinel: true,
                condition: expect.any(String),
            },
        });
    });

    it('rejects ordinary transcript attachments', () => {
        expect(parseClaudeGoalStatusTranscriptEvent({
            type: 'attachment',
            uuid: 'att-1',
            sessionId: 'claude-1',
            attachment: { type: 'skill_listing', content: 'skills' },
        })).toBeNull();

        expect(parseClaudeGoalStatusTranscriptEvent({
            type: 'assistant',
            uuid: 'msg-1',
            sessionId: 'claude-1',
            message: { role: 'assistant', content: 'hello' },
        })).toBeNull();
    });
});

describe('mapClaudeGoalStatusEventToAgentGoalStatus', () => {
    it('maps active goal_status attachments to active agent goal state', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-19T10:00:00.000Z'));

        const event = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        const status = mapClaudeGoalStatusEventToAgentGoalStatus(event, event.sourceSessionId, {
            capabilities: { clear: true, edit: true },
        });

        expect(status).toEqual({
            source: 'claude',
            observedAt: Date.now(),
            sourceSessionId: event.sourceSessionId,
            sourceRevision: event.uuid,
            status: 'active',
            text: event.attachment.condition,
            capabilities: { clear: true, edit: true },
        });

        vi.useRealTimers();
    });

    it('maps completed goal_status attachments to inactive completed state without storing evaluator details', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('completed.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        const status = mapClaudeGoalStatusEventToAgentGoalStatus(event, event.sourceSessionId);

        expect(status).toMatchObject({
            source: 'claude',
            sourceSessionId: event.sourceSessionId,
            sourceRevision: event.uuid,
            status: 'inactive',
            reason: 'completed',
        });
        const serialized = JSON.stringify(status);
        expect(serialized).not.toContain(event.attachment.reason ?? '');
        expect(serialized).not.toContain('durationMs');
        expect(serialized).not.toContain('tokens');
    });

    it('maps sentinel met true goal_status attachments to inactive cleared state', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('cleared.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        expect(mapClaudeGoalStatusEventToAgentGoalStatus(event, event.sourceSessionId)).toMatchObject({
            source: 'claude',
            sourceSessionId: event.sourceSessionId,
            sourceRevision: event.uuid,
            status: 'inactive',
            reason: 'cleared',
        });
    });

    it('ignores goal_status events for another Claude session', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        expect(mapClaudeGoalStatusEventToAgentGoalStatus(event, 'different-session')).toBeNull();
    });
});

describe('reduceClaudeGoalStatusEvents', () => {
    it('uses the latest state in transcript order', () => {
        const active = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        const cleared = parseClaudeGoalStatusTranscriptEvent(fixture('cleared.jsonl'));
        if (!active || !cleared) throw new Error('expected fixtures to parse');

        const latest = reduceClaudeGoalStatusEvents([cleared, active], active.sourceSessionId);

        expect(latest).toMatchObject({
            status: 'active',
            text: active.attachment.condition,
            sourceSessionId: active.sourceSessionId,
        });
    });

    it('ignores events from other Claude sessions while reducing', () => {
        const active = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        const completed = parseClaudeGoalStatusTranscriptEvent(fixture('completed.jsonl'));
        if (!active || !completed) throw new Error('expected fixtures to parse');

        const latest = reduceClaudeGoalStatusEvents([completed, active], active.sourceSessionId);

        expect(latest).toMatchObject({
            status: 'active',
            sourceSessionId: active.sourceSessionId,
        });
    });
});

describe('claudeGoalActionCapabilities', () => {
    it('returns partial capabilities only for confirmed action paths', () => {
        expect(claudeGoalActionCapabilities({
            goalCommandSupported: true,
            observedGoalStatus: true,
            confirmedActions: { clear: true, edit: false },
        })).toEqual({ clear: true });

        expect(claudeGoalActionCapabilities({
            goalCommandSupported: true,
            observedGoalStatus: true,
            confirmedActions: { clear: false, edit: true },
        })).toEqual({ edit: true });
    });

    it('returns undefined when goal command support or observed goal status is missing', () => {
        expect(claudeGoalActionCapabilities({
            goalCommandSupported: false,
            observedGoalStatus: true,
            confirmedActions: { clear: true, edit: true },
        })).toBeUndefined();

        expect(claudeGoalActionCapabilities({
            goalCommandSupported: true,
            observedGoalStatus: false,
            confirmedActions: { clear: true, edit: true },
        })).toBeUndefined();

        expect(claudeGoalActionCapabilities({
            goalCommandSupported: true,
            observedGoalStatus: true,
            confirmedActions: { clear: false, edit: false },
        })).toBeUndefined();
    });
});

describe('parseClaudeGoalActionParams', () => {
    it('parses clear and edit RPC params', () => {
        expect(parseClaudeGoalActionParams({ action: 'clear' })).toEqual({ type: 'clear' });
        expect(parseClaudeGoalActionParams({ action: 'edit', objective: '  updated goal  ' })).toEqual({
            type: 'set',
            objective: 'updated goal',
        });
    });

    it('rejects unsupported, stop, and empty edit requests', () => {
        expect(parseClaudeGoalActionParams({ action: 'stop' })).toBeNull();
        expect(parseClaudeGoalActionParams({ action: 'edit', objective: '   ' })).toBeNull();
        expect(parseClaudeGoalActionParams({ action: 'edit' })).toBeNull();
    });
});
