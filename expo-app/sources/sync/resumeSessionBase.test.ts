import { describe, expect, it } from 'vitest';

import { buildResumeSessionBaseOptionsFromSession } from './resumeSessionBase';

describe('buildResumeSessionBaseOptionsFromSession', () => {
    it('returns null when session metadata is missing', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: null } as any,
            resumeCapabilityOptions: {},
        })).toBeNull();
    });

    it('returns null when vendor resume is not allowed', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: {}, // codex not enabled
        })).toBeNull();
    });

    it('returns base options when vendor resume is allowed and present', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agent: 'codex',
            resume: 'x1',
        });
    });

    it('passes through permission mode overrides', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' } } as any,
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
