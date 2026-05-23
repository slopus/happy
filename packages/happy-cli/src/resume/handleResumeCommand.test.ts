import { describe, expect, it } from 'vitest';

import { buildReconnectEnv, buildResumeLaunch, formatResumeHelp, parseResumeCommandArgs } from './handleResumeCommand';
import type { ReconnectableHappySession } from './resolveHappySession';

describe('parseResumeCommandArgs', () => {
    it('parses the happy session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({
            showHelp: true,
            sessionId: '',
        });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow(
            'Happy session ID is required: happy resume <session-id>',
        );
    });
});

describe('buildResumeLaunch', () => {
    it('builds a Codex resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('builds a Claude resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-2',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'],
        });
    });

    it('rejects unsupported flavors', () => {
        expect(() => buildResumeLaunch({
            id: 'session-3',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'gemini',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow('Happy session session-3 uses unsupported flavor "gemini".');
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('happy resume <happy-session-id>');
    });
});

describe('buildReconnectEnv', () => {
    const sample: ReconnectableHappySession = {
        id: 'cmmij8olq00dp5jcxr3wtbpau',
        active: false,
        metadata: {
            path: '/tmp/repo',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
            host: 'localhost',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happy',
            happyLibDir: '/tmp/happy',
            happyToolsDir: '/tmp/happy/tools',
        },
        seq: 42,
        metadataVersion: 7,
        agentStateVersion: 3,
        encryptionKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        encryptionVariant: 'dataKey',
    };

    it('produces all reconnect env vars the CLI receiver expects', () => {
        const env = buildReconnectEnv(sample);
        expect(env).toEqual({
            HAPPY_RECONNECT_SESSION_ID: 'cmmij8olq00dp5jcxr3wtbpau',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'AQIDBAUGBwg=',
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
            HAPPY_RECONNECT_SEQ: '42',
            HAPPY_RECONNECT_METADATA_VERSION: '7',
            HAPPY_RECONNECT_AGENT_STATE_VERSION: '3',
        });
    });

    it('preserves the legacy encryption variant tag', () => {
        const env = buildReconnectEnv({ ...sample, encryptionVariant: 'legacy' });
        expect(env.HAPPY_RECONNECT_ENCRYPTION_VARIANT).toBe('legacy');
    });

    it('stringifies numeric versions and seq so they survive process.env', () => {
        const env = buildReconnectEnv({ ...sample, seq: 0, metadataVersion: 0, agentStateVersion: 0 });
        expect(env.HAPPY_RECONNECT_SEQ).toBe('0');
        expect(env.HAPPY_RECONNECT_METADATA_VERSION).toBe('0');
        expect(env.HAPPY_RECONNECT_AGENT_STATE_VERSION).toBe('0');
    });
});
