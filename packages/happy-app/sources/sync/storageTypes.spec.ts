import { describe, expect, it } from 'vitest';
import { AgentGoalStatusSchema, AgentStateSchema, MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('preserves archive lifecycle metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            startedBy: 'daemon',
            startedFromDaemon: true,
            lifecycleState: 'archived',
            lifecycleStateSince: 123,
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        });

        expect(metadata.startedBy).toBe('daemon');
        expect(metadata.startedFromDaemon).toBe(true);
        expect(metadata.lifecycleState).toBe('archived');
        expect(metadata.lifecycleStateSince).toBe(123);
        expect(metadata.archivedBy).toBe('cli');
        expect(metadata.archiveReason).toBe('User terminated');
    });
});

describe('AgentGoalStatusSchema', () => {
    it('accepts active goal state with source identity and capabilities', () => {
        const goal = AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the current task',
            observedAt: 1710000000000,
            sourceSessionId: 'claude-session-1',
            sourceRevision: 7,
            capabilities: {
                clear: true,
                stop: false,
            },
            progress: {
                currentStep: 1,
                totalSteps: 2,
                steps: [
                    { text: 'inspect source', status: 'completed' },
                    { text: 'write fix', status: 'in_progress' },
                ],
            },
        });

        expect(goal.status).toBe('active');
        if (goal.status !== 'active') {
            throw new Error('expected active goal');
        }
        expect(goal.text).toBe('finish the current task');
        expect(goal.capabilities?.clear).toBe(true);
        expect(goal.progress?.steps).toHaveLength(2);
    });

    it('accepts inactive and unavailable states', () => {
        expect(AgentGoalStatusSchema.parse({
            status: 'inactive',
            source: 'codex',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            reason: 'completed',
        })).toMatchObject({ status: 'inactive', reason: 'completed' });

        expect(AgentGoalStatusSchema.parse({
            status: 'unavailable',
            source: 'claude',
            observedAt: 1710000000000,
            reason: 'unsupported',
        })).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    });

    it('rejects active state without non-empty text', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: '   ',
            observedAt: 1710000000000,
            sourceSessionId: 'claude-session-1',
        })).toThrow();
    });

    it('rejects active state without source identity', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: 1710000000000,
        })).toThrow();
    });

    it('rejects malformed capabilities and progress payloads', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: 'claude-session-1',
            capabilities: { clear: 'yes' },
        })).toThrow();

        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            progress: {
                currentStep: 0,
                totalSteps: 1,
                steps: [{ text: 'bad', status: 'unknown' }],
            },
        })).toThrow();
    });

    it('rejects empty source identity values', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: '   ',
        })).toThrow();

        expect(() => AgentGoalStatusSchema.parse({
            status: 'inactive',
            source: 'codex',
            observedAt: 1710000000000,
            sourceRevision: '',
        })).toThrow();
    });

    it('rejects invalid observation timestamps', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: -1,
            sourceSessionId: 'claude-session-1',
        })).toThrow();
    });

    it('preserves agent goal status through AgentStateSchema', () => {
        const state = AgentStateSchema.parse({
            controlledByUser: true,
            agentGoalStatus: {
                status: 'active',
                source: 'codex',
                text: 'review the branch',
                observedAt: 1710000000000,
                sourceSessionId: 'codex-thread-1',
            },
        });

        expect(state.agentGoalStatus?.status).toBe('active');
    });
});
