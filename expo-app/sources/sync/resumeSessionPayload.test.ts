import { describe, expect, test } from 'vitest';

import { buildResumeHappySessionRpcParams } from './resumeSessionPayload';

describe('buildResumeHappySessionRpcParams', () => {
    test('builds typed params for resume-session', () => {
        expect(buildResumeHappySessionRpcParams({
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            sessionEncryptionKeyBase64: 'abc',
            sessionEncryptionVariant: 'dataKey',
        })).toEqual({
            type: 'resume-session',
            sessionId: 's1',
            directory: '/tmp',
            agent: 'claude',
            sessionEncryptionKeyBase64: 'abc',
            sessionEncryptionVariant: 'dataKey',
        });
    });
});

