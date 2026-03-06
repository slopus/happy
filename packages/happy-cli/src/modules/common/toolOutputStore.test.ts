import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../api/encryption';
import { registerCommonHandlers } from './registerCommonHandlers';
import { getToolOutputRecord, saveToolOutputRecord, type ToolOutputRecord } from './toolOutputStore';

vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: '/tmp/happy-cli-test-home',
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
    },
}));

const outputsDir = join(configuration.happyHomeDir, 'tool-outputs');
const testSessionId = 'test-session-tool-output-store';

function createRpcHandlerManager(): RpcHandlerManager {
    return new RpcHandlerManager({
        scopePrefix: 'session',
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy',
        logger: () => {},
    });
}

describe('toolOutputStore', () => {
    beforeEach(() => {
        const filePath = join(outputsDir, `${testSessionId}.json`);
        if (existsSync(filePath)) rmSync(filePath);
    });

    afterEach(() => {
        const filePath = join(outputsDir, `${testSessionId}.json`);
        if (existsSync(filePath)) rmSync(filePath);
    });

    it('saves and retrieves a record', () => {
        const record: ToolOutputRecord = {
            callId: 'call-1',
            toolName: 'Read',
            agent: 'claude',
            result: { file: { content: 'hello world', filePath: '/a.ts' } },
            timestamp: Date.now(),
        };

        saveToolOutputRecord(testSessionId, record);
        const retrieved = getToolOutputRecord(testSessionId, 'call-1');

        expect(retrieved).not.toBeNull();
        expect(retrieved!.callId).toBe('call-1');
        expect(retrieved!.toolName).toBe('Read');
        expect(retrieved!.agent).toBe('claude');
        expect((retrieved!.result as any).file.content).toBe('hello world');
    });

    it('returns null for missing record', () => {
        expect(getToolOutputRecord(testSessionId, 'missing-call')).toBeNull();
    });

    it('returns null for missing session', () => {
        expect(getToolOutputRecord('missing-session', 'call-1')).toBeNull();
    });

    it('appends multiple records for one session file', () => {
        saveToolOutputRecord(testSessionId, {
            callId: 'call-1',
            toolName: 'Read',
            agent: 'claude',
            result: { data: 'first' },
            timestamp: Date.now(),
        });
        saveToolOutputRecord(testSessionId, {
            callId: 'call-2',
            toolName: 'CodexBash',
            agent: 'codex',
            result: { stdout: 'second' },
            timestamp: Date.now(),
        });

        expect(getToolOutputRecord(testSessionId, 'call-1')).not.toBeNull();
        expect(getToolOutputRecord(testSessionId, 'call-2')).not.toBeNull();

        const raw = JSON.parse(readFileSync(join(outputsDir, `${testSessionId}.json`), 'utf-8'));
        expect(raw).toHaveLength(2);
    });
});

describe('getToolOutput rpc', () => {
    it('returns stored output for the current session scope', async () => {
        const manager = createRpcHandlerManager();
        registerCommonHandlers(manager, '/tmp', testSessionId);

        saveToolOutputRecord(testSessionId, {
            callId: 'call-1',
            toolName: 'GeminiBash',
            agent: 'gemini',
            result: { stdout: 'hello', stderr: '', exit_code: 0 },
            timestamp: Date.now(),
        });

        const params = encodeBase64(
            encrypt(new Uint8Array(32).fill(7), 'legacy', { callId: 'call-1' })
        );

        const response = await manager.handleRequest({
            method: 'session:getToolOutput',
            params,
        });

        const decoded = decrypt(
            new Uint8Array(32).fill(7),
            'legacy',
            decodeBase64(response)
        );

        expect(decoded).toEqual({
            success: true,
            toolName: 'GeminiBash',
            agent: 'gemini',
            result: { stdout: 'hello', stderr: '', exit_code: 0 },
        });
    });

    it('returns not_found when no record exists', async () => {
        const manager = createRpcHandlerManager();
        registerCommonHandlers(manager, '/tmp', testSessionId);

        const params = encodeBase64(
            encrypt(new Uint8Array(32).fill(7), 'legacy', { callId: 'missing-call' })
        );

        const response = await manager.handleRequest({
            method: 'session:getToolOutput',
            params,
        });

        const decoded = decrypt(
            new Uint8Array(32).fill(7),
            'legacy',
            decodeBase64(response)
        );

        expect(decoded).toEqual({
            success: false,
            error: 'not_found',
        });
    });
});
