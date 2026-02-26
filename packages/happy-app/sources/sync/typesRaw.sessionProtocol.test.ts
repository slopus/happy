import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { normalizeRawMessage } from './typesRaw';

describe('Session protocol normalization', () => {
    let originalEnableSessionProtocolSend: string | undefined;
    let originalExpoEnableSessionProtocolSend: string | undefined;

    beforeEach(() => {
        originalEnableSessionProtocolSend = process.env.ENABLE_SESSION_PROTOCOL_SEND;
        originalExpoEnableSessionProtocolSend = process.env.EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND;
        delete process.env.ENABLE_SESSION_PROTOCOL_SEND;
        delete process.env.EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND;
    });

    afterEach(() => {
        if (originalEnableSessionProtocolSend === undefined) {
            delete process.env.ENABLE_SESSION_PROTOCOL_SEND;
        } else {
            process.env.ENABLE_SESSION_PROTOCOL_SEND = originalEnableSessionProtocolSend;
        }
        if (originalExpoEnableSessionProtocolSend === undefined) {
            delete process.env.EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND;
        } else {
            process.env.EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND = originalExpoEnableSessionProtocolSend;
        }
    });

    const base = {
        role: 'agent' as const,
        content: {
            type: 'session' as const,
        }
    };

    it('normalizes text events to agent text content', () => {
        const normalized = normalizeRawMessage('db-1', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-1',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    ev: { t: 'text', text: 'hello session' }
                }
            }
        });

        expect(normalized).toBeTruthy();
        expect(normalized?.id).toBe('env-1');
        expect(normalized?.createdAt).toBe(1);
        expect(normalized?.role).toBe('agent');
        if (normalized && normalized.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'text',
                text: 'hello session',
                uuid: 'env-1',
                parentUUID: null
            });
        }
    });

    it('normalizes new direct session-role envelope shape', () => {
        const normalized = normalizeRawMessage('db-1-direct', null, 1, {
            role: 'session',
            content: {
                id: 'env-1-direct',
                time: 1,
                role: 'agent',
                turn: 'turn-1',
                ev: { t: 'text', text: 'hello direct session envelope' }
            }
        } as any);

        expect(normalized).toBeTruthy();
        expect(normalized?.id).toBe('env-1-direct');
        expect(normalized?.createdAt).toBe(1);
        expect(normalized?.role).toBe('agent');
        if (normalized && normalized.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'text',
                text: 'hello direct session envelope',
                uuid: 'env-1-direct',
                parentUUID: null
            });
        }
    });

    it('normalizes thinking text events', () => {
        const normalized = normalizeRawMessage('db-2', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-2',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    ev: { t: 'text', text: 'thinking...', thinking: true }
                }
            }
        });

        expect(normalized).toBeTruthy();
        if (normalized && normalized.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'thinking',
                thinking: 'thinking...',
                uuid: 'env-2',
                parentUUID: null
            });
        }
    });

    it('drops modern user session envelopes when send flag is disabled', () => {
        const normalized = normalizeRawMessage('db-modern-user-flag-off-1', null, 1, {
            role: 'session',
            content: {
                id: 'env-modern-user-flag-off-1',
                time: 1,
                role: 'user',
                ev: { t: 'text', text: 'modern user envelope' }
            }
        } as any);

        expect(normalized).toBeNull();
    });

    it('uses modern user session envelopes for user content when send flag is enabled', () => {
        process.env.ENABLE_SESSION_PROTOCOL_SEND = 'true';

        const normalized = normalizeRawMessage('db-modern-user-flag-on', null, 1, {
            role: 'session',
            content: {
                id: 'env-modern-user-flag-on',
                time: 1,
                role: 'user',
                ev: { t: 'text', text: 'new user protocol' }
            }
        } as any);

        expect(normalized).toBeTruthy();
        expect(normalized?.role).toBe('user');
        if (normalized && normalized.role === 'user') {
            expect(normalized.content).toEqual({
                type: 'text',
                text: 'new user protocol'
            });
        }
    });

    it('drops legacy user text envelopes when send flag is enabled', () => {
        process.env.ENABLE_SESSION_PROTOCOL_SEND = 'true';

        const normalized = normalizeRawMessage('db-user-legacy-flag-on', null, 1, {
            role: 'user',
            content: {
                type: 'text',
                text: 'legacy user protocol'
            }
        } as any);

        expect(normalized).toBeNull();
    });

    it('normalizes service events to visible agent text', () => {
        const normalized = normalizeRawMessage('db-service-1', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-service-1',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-service-1',
                    ev: { t: 'service', text: '**Service:** Connection restored' }
                }
            }
        });

        expect(normalized).toBeTruthy();
        expect(normalized?.role).toBe('agent');
        if (normalized && normalized.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'text',
                text: '**Service:** Connection restored',
                uuid: 'env-service-1',
                parentUUID: null
            });
        }
    });

    it('normalizes tool-call lifecycle events', () => {
        const start = normalizeRawMessage('db-3', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-3',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    ev: {
                        t: 'tool-call-start',
                        call: 'call-1',
                        name: 'CodexBash',
                        title: 'Run `ls`',
                        description: 'Run command',
                        args: { command: 'ls' }
                    }
                }
            }
        });
        expect(start).toBeTruthy();
        if (start && start.role === 'agent') {
            expect(start.content[0]).toMatchObject({
                type: 'tool-call',
                id: 'call-1',
                name: 'CodexBash',
                input: { command: 'ls' }
            });
        }

        const end = normalizeRawMessage('db-4', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-4',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    ev: {
                        t: 'tool-call-end',
                        call: 'call-1'
                    }
                }
            }
        });
        expect(end).toBeTruthy();
        if (end && end.role === 'agent') {
            expect(end.content[0]).toMatchObject({
                type: 'tool-result',
                tool_use_id: 'call-1',
                content: null,
                is_error: false
            });
        }
    });

    it('maps turn-end to ready event and drops turn-start', () => {
        const turnStart = normalizeRawMessage('db-5', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-5',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-5',
                    ev: { t: 'turn-start' }
                }
            }
        });
        expect(turnStart).toBeNull();

        const turnEnd = normalizeRawMessage('db-6', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-6',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-5',
                    ev: { t: 'turn-end', status: 'completed' }
                }
            }
        });
        expect(turnEnd).toMatchObject({
            id: 'env-6',
            role: 'event',
            content: { type: 'ready' }
        });
    });

    it('normalizes file events with required size and optional image metadata', () => {
        const fileOnly = normalizeRawMessage('db-file-1', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-file-1',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-file-1',
                    ev: {
                        t: 'file',
                        ref: 'upload-file-1',
                        name: 'report.pdf',
                        size: 1234
                    }
                }
            }
        });

        expect(fileOnly).toBeTruthy();
        if (fileOnly && fileOnly.role === 'agent') {
            expect(fileOnly.content[0]).toMatchObject({
                type: 'tool-call',
                name: 'file',
                input: {
                    ref: 'upload-file-1',
                    name: 'report.pdf',
                    size: 1234
                },
                description: 'Attached file: report.pdf'
            });
        }

        const imageFile = normalizeRawMessage('db-file-2', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-file-2',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-file-2',
                    ev: {
                        t: 'file',
                        ref: 'upload-file-2',
                        name: 'photo.png',
                        size: 4567,
                        image: {
                            width: 800,
                            height: 600,
                            thumbhash: 'abc'
                        }
                    }
                }
            }
        });

        expect(imageFile).toBeTruthy();
        if (imageFile && imageFile.role === 'agent') {
            expect(imageFile.content[0]).toMatchObject({
                type: 'tool-call',
                name: 'file',
                input: {
                    ref: 'upload-file-2',
                    name: 'photo.png',
                    size: 4567,
                    image: {
                        width: 800,
                        height: 600,
                        thumbhash: 'abc'
                    }
                },
                description: 'Attached image: photo.png (800x600)'
            });
        }
    });

    it('rejects file events without required size', () => {
        const normalized = normalizeRawMessage('db-file-missing-size', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-file-missing-size',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-file-3',
                    ev: {
                        t: 'file',
                        ref: 'upload-file-3',
                        name: 'broken.bin'
                    }
                }
            }
        } as any);

        expect(normalized).toBeNull();
    });

    it('marks subagent-linked messages as sidechain messages', () => {
        const subagent = createId();
        const normalized = normalizeRawMessage('db-7', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-7',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-2',
                    subagent,
                    ev: { t: 'text', text: 'subagent output' }
                }
            }
        });

        expect(normalized).toBeTruthy();
        expect(normalized?.isSidechain).toBe(true);
        if (normalized && normalized.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                parentUUID: subagent
            });
        }
    });

    it('drops start/stop lifecycle markers', () => {
        const subagent = createId();
        const start = normalizeRawMessage('db-start-1', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-start-1',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    subagent,
                    ev: { t: 'start', title: 'Research agent' }
                }
            }
        });
        expect(start).toBeNull();

        const stop = normalizeRawMessage('db-stop-1', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-stop-1',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    subagent,
                    ev: { t: 'stop' }
                }
            }
        });
        expect(stop).toBeNull();
    });

    it('returns null for non-cuid subagent identifiers', () => {
        const normalized = normalizeRawMessage('db-subagent-invalid', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-subagent-invalid',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-1',
                    subagent: 'toolu_provider_id',
                    ev: { t: 'text', text: 'should be dropped' }
                }
            }
        } as any);

        expect(normalized).toBeNull();
    });

    it('returns null for malformed session payloads', () => {
        const normalized = normalizeRawMessage('db-8', null, 1, {
            role: 'agent',
            content: {
                type: 'session',
                data: {
                    id: 'env-8',
                    time: 1,
                    role: 'agent',
                    ev: {
                        t: 'tool-call-start',
                        call: 'call-1',
                        name: 'Bash'
                    }
                }
            }
        } as any);

        expect(normalized).toBeNull();
    });

    it('returns null for agent session events without turn', () => {
        const normalized = normalizeRawMessage('db-9', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-9',
                    time: 1,
                    role: 'agent',
                    ev: { t: 'text', text: 'missing turn' }
                }
            }
        });

        expect(normalized).toBeNull();
    });

    it('returns null for turn-end session events without status', () => {
        const normalized = normalizeRawMessage('db-10', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-10',
                    time: 1,
                    role: 'agent',
                    turn: 'turn-5',
                    ev: { t: 'turn-end' }
                }
            }
        } as any);

        expect(normalized).toBeNull();
    });

    it('returns null for service events from user role', () => {
        const normalized = normalizeRawMessage('db-11', null, 1, {
            ...base,
            content: {
                type: 'session',
                data: {
                    id: 'env-11',
                    time: 1,
                    role: 'user',
                    ev: { t: 'service', text: 'not allowed' }
                }
            }
        } as any);

        expect(normalized).toBeNull();
    });
});
