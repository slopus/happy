import { describe, expect, it } from 'vitest';
import { AgentGoalStatusSchema, AgentStateSchema, MachineMetadataSchema, MetadataSchema } from './storageTypes';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

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

    it('parses the additive Rig v1 extension and tolerates future fields', () => {
        const metadata = MetadataSchema.parse({
            ...rigMetadataFixture,
            rigMetadataVersion: 2,
            futureCapability: { supported: true },
        });
        expect(metadata.client?.id).toBe('rig');
        expect(metadata.models).toHaveLength(2);
        expect(metadata.activity?.subagents.queued).toBe(2);
        expect((metadata as any).futureCapability).toEqual({ supported: true });
    });
});

describe('MachineMetadataSchema', () => {
    it('preserves the Rig creation catalog and future machine fields', () => {
        const metadata = MachineMetadataSchema.parse({
            host: 'workstation',
            platform: 'darwin',
            happyCliVersion: '0.0.136',
            happyHomeDir: '/Users/dev/.happy',
            homeDir: '/Users/dev',
            machineKind: 'rig',
            rigOnly: true,
            rigMetadataVersion: 1,
            client: { id: 'rig', name: 'Rig', version: '0.0.136' },
            cliAvailability: {
                claude: false,
                codex: false,
                gemini: false,
                openclaw: false,
                agy: false,
                rig: true,
                detectedAt: 123,
            },
            capabilities: { newSession: true, resume: false, worktrees: false },
            defaults: {
                effort: 'high',
                modelId: 'gpt-5.6-sol',
                permissionMode: 'auto',
                providerId: 'codex',
            },
            providers: [{ id: 'codex', kind: 'codex', name: 'OpenAI Codex' }],
            models: [{
                id: 'gpt-5.6-sol',
                code: 'gpt-5.6-sol',
                name: 'GPT-5.6 Sol',
                value: 'GPT-5.6 Sol',
                providerId: 'codex',
                providerKind: 'codex',
                providerName: 'OpenAI Codex',
                provider: { id: 'codex', kind: 'codex', name: 'OpenAI Codex' },
                serviceTiers: [],
                thinkingLevels: ['low', 'high'],
                defaultThinkingLevel: 'high',
            }],
            operatingModes: [{
                code: 'auto',
                value: 'Auto',
                description: 'Reviews elevated actions automatically.',
                kind: 'safe-yolo',
            }],
            sessionCreation: {
                idempotencyKey: 'clientRequestId',
                pendingRetryAfterMs: 2_000,
                resultKinds: ['success', 'pending', 'requestToApproveDirectoryCreation', 'error'],
            },
            futureRigMachineField: { enabled: true },
        });

        expect(metadata.cliAvailability?.rig).toBe(true);
        expect(metadata.defaults?.providerId).toBe('codex');
        expect(metadata.models?.[0]?.thinkingLevels).toEqual(['low', 'high']);
        expect((metadata as any).futureRigMachineField).toEqual({ enabled: true });
    });

    // A failed parse returns null for the whole metadata object, so anything Rig
    // may legitimately omit has to survive. These are the shapes its own session
    // schema already permits.
    const machineBase = {
        host: 'workstation',
        platform: 'darwin',
        happyCliVersion: '0.0.136',
        happyHomeDir: '/Users/dev/.happy',
        homeDir: '/Users/dev',
        machineKind: 'rig',
        cliAvailability: {
            claude: false,
            codex: false,
            gemini: false,
            openclaw: false,
            agy: false,
            rig: true,
            detectedAt: 123,
        },
    };

    it.each([
        ['a model without a reasoning level', { models: [{ code: 'c', value: 'v', id: 'm', providerId: 'p' }] }],
        ['a model with a null reasoning level', { models: [{ code: 'c', value: 'v', id: 'm', providerId: 'p', defaultThinkingLevel: null }] }],
        ['an operating mode with a null description', { operatingModes: [{ code: 'auto', value: 'Auto', description: null }] }],
        ['an operating mode without a kind', { operatingModes: [{ code: 'auto', value: 'Auto', description: 'd' }] }],
        ['partial defaults', { defaults: { providerId: 'codex' } }],
        ['an unreadable catalog block', { models: 'not-an-array' }],
    ])('keeps the rest of the machine when Rig publishes %s', (_label, rigFields) => {
        const metadata = MachineMetadataSchema.parse({ ...machineBase, ...rigFields });

        expect(metadata.host).toBe('workstation');
        expect(metadata.platform).toBe('darwin');
        expect(metadata.cliAvailability?.rig).toBe(true);
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

    it('preserves usage limits in agent state and degrades malformed snapshots', () => {
        const state = AgentStateSchema.parse({
            controlledByUser: true,
            usageLimits: {
                capturedAt: 1710000000000,
                windows: [{ id: 'five_hour', status: 'allowed', utilization: 42, resetsAt: null }],
            },
        });
        expect(state.usageLimits?.windows[0].id).toBe('five_hour');

        const malformed = AgentStateSchema.parse({
            controlledByUser: true,
            usageLimits: { capturedAt: 'bad', windows: [] },
        });
        expect(malformed.controlledByUser).toBe(true);
        expect(malformed.usageLimits).toBeUndefined();
    });
});
