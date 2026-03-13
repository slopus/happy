import { describe, expect, it } from 'vitest';
import {
    MAX_SESSION_MODE_ENTRIES,
    applySessionModeConfigPatch,
    createEmptySessionModeConfig,
    decodeSessionModeConfigValue,
    encodeSessionModeConfigValue,
    getLastUsedForAgent,
    getSessionModeForSession,
    type SessionModeConfigPatch,
} from './sessionModeConfig';

function patch(overrides: Partial<SessionModeConfigPatch>): SessionModeConfigPatch {
    return {
        agentType: 'claude',
        permissionMode: 'default',
        modelMode: 'default',
        updatedAt: 1,
        includeLastUsed: false,
        includeSessionEntry: false,
        ...overrides,
    };
}

describe('sessionModeConfig', () => {
    it('dedupes by sessionId and keeps newest entry', () => {
        const base = createEmptySessionModeConfig(100);
        const next = applySessionModeConfigPatch(
            applySessionModeConfigPatch(
                base,
                patch({
                    includeSessionEntry: true,
                    sessionId: 's1',
                    permissionMode: 'acceptEdits',
                    modelMode: 'claude-sonnet-4-6',
                    updatedAt: 100,
                }),
            ),
            patch({
                includeSessionEntry: true,
                sessionId: 's1',
                permissionMode: 'plan',
                modelMode: 'claude-opus-4-6',
                updatedAt: 200,
            }),
        );

        expect(next.sessions).toHaveLength(1);
        expect(next.sessions[0]).toMatchObject({
            sessionId: 's1',
            permissionMode: 'plan',
            modelMode: 'claude-opus-4-6',
            updatedAt: 200,
        });
    });

    it('keeps only most recent 100 sessions', () => {
        let doc = createEmptySessionModeConfig(0);
        for (let i = 0; i < MAX_SESSION_MODE_ENTRIES + 20; i += 1) {
            doc = applySessionModeConfigPatch(
                doc,
                patch({
                    includeSessionEntry: true,
                    sessionId: `s${i}`,
                    updatedAt: i,
                }),
            );
        }

        expect(doc.sessions).toHaveLength(MAX_SESSION_MODE_ENTRIES);
        expect(doc.sessions[0]?.sessionId).toBe(`s${MAX_SESSION_MODE_ENTRIES + 19}`);
        expect(doc.sessions.at(-1)?.sessionId).toBe('s20');
    });

    it('updates lastUsed by agent independently', () => {
        let doc = createEmptySessionModeConfig(0);
        doc = applySessionModeConfigPatch(
            doc,
            patch({
                agentType: 'claude',
                includeLastUsed: true,
                permissionMode: 'plan',
                modelMode: 'claude-opus-4-6',
                updatedAt: 100,
            }),
        );
        doc = applySessionModeConfigPatch(
            doc,
            patch({
                agentType: 'codex',
                includeLastUsed: true,
                permissionMode: 'safe-yolo',
                modelMode: 'gpt-5.4-high',
                updatedAt: 200,
            }),
        );

        expect(getLastUsedForAgent(doc, 'claude')).toMatchObject({
            permissionMode: 'plan',
            modelMode: 'claude-opus-4-6',
        });
        expect(getLastUsedForAgent(doc, 'codex')).toMatchObject({
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5.4-high',
        });
    });

    it('preserves default values in session entries (new session case)', () => {
        const doc = applySessionModeConfigPatch(
            createEmptySessionModeConfig(0),
            patch({
                includeSessionEntry: true,
                sessionId: 's-default',
                permissionMode: 'default',
                modelMode: 'default',
                updatedAt: 42,
            }),
        );

        expect(getSessionModeForSession(doc, 's-default')).toMatchObject({
            permissionMode: 'default',
            modelMode: 'default',
        });
    });

    it('falls back to empty doc when payload is corrupted', () => {
        const doc = decodeSessionModeConfigValue('!!!invalid!!!');
        expect(doc.schemaVersion).toBe(1);
        expect(doc.sessions).toEqual([]);
        expect(doc.lastUsedByAgent).toEqual({});
    });

    it('round-trips through base64 encoding/decoding', () => {
        const original = applySessionModeConfigPatch(
            createEmptySessionModeConfig(10),
            patch({
                includeSessionEntry: true,
                sessionId: 's1',
                permissionMode: 'acceptEdits',
                modelMode: 'claude-sonnet-4-6',
                includeLastUsed: true,
                updatedAt: 11,
            }),
        );
        const encoded = encodeSessionModeConfigValue(original);
        const decoded = decodeSessionModeConfigValue(encoded);

        expect(decoded).toEqual(original);
    });
});
