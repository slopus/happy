import { describe, expect, it } from 'vitest';
import { getPendingQueueWakeResumeOptions } from './pendingQueueWake';

describe('getPendingQueueWakeResumeOptions', () => {
    it('returns resume options for a resumable idle session', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        const res = getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: {},
        });

        expect(res).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'claude',
            resume: 'c1',
        });
    });

    it('returns null when agent is thinking', () => {
        const session: any = {
            thinking: true,
            agentState: null,
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toBeNull();
    });

    it('returns null when permission is required', () => {
        const session: any = {
            thinking: false,
            agentState: { requests: { r1: { id: 'r1' } } },
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toBeNull();
    });

    it('does not block wake for offline sessions with stale thinking state', () => {
        const session: any = {
            thinking: true,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'claude',
            resume: 'c1',
        });
    });

    it('does not block wake for offline sessions with stale permission requests', () => {
        const session: any = {
            thinking: false,
            agentState: { requests: { r1: { id: 'r1' } } },
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'claude',
            resume: 'c1',
        });
    });

    it('returns null when metadata is missing', () => {
        const session: any = { thinking: false, agentState: null, metadata: null };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toBeNull();
    });

    it('returns null when flavor is unsupported', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'unknown' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toBeNull();
    });

    it('returns null when codex vendor resume is disabled', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'codex', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toBeNull();
    });

    it('returns codex options when codex resume is enabled', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'codex', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'codex',
            resume: 'x1',
            experimentalCodexResume: true,
        });
    });

    it('canonicalizes codex flavor aliases when building wake options', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'codex',
            resume: 'x1',
            experimentalCodexResume: true,
        });
    });

    it('returns null when gemini vendor resume is not enabled', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'gemini', geminiSessionId: 'g1' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: {} })).toBeNull();
    });

    it('includes gemini resume id only when runtime resume is enabled', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'gemini', geminiSessionId: 'g1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { allowRuntimeResumeByAgentId: { gemini: true } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'gemini',
            resume: 'g1',
        });
    });

    it('passes through permission mode override when provided', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: {},
            permissionOverride: { permissionMode: 'plan', permissionModeUpdatedAt: 123 },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'claude',
            resume: 'c1',
            permissionMode: 'plan',
            permissionModeUpdatedAt: 123,
        });
    });
});
