import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { getLatestSessionModelMetadata } from './newSessionModelMetadata';

function session(args: {
    id: string;
    machineId?: string;
    flavor?: string | null;
    activeAt: number;
    models?: Array<{ code: string; value: string; description?: string | null }>;
    codexAccountProfileId?: string;
}): Session {
    return {
        id: args.id,
        seq: 1,
        createdAt: args.activeAt,
        updatedAt: args.activeAt,
        active: false,
        activeAt: args.activeAt,
        metadata: {
            path: '/repo',
            host: 'machine',
            machineId: args.machineId,
            flavor: args.flavor,
            models: args.models,
            codexAccountProfileId: args.codexAccountProfileId,
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: args.activeAt,
    };
}

describe('getLatestSessionModelMetadata', () => {
    it('returns the newest model metadata for the selected machine and agent', () => {
        const latest = getLatestSessionModelMetadata({
            sessions: [
                'loading',
                session({
                    id: 'old-codex',
                    machineId: 'mac',
                    flavor: 'codex',
                    activeAt: 10,
                    models: [{ code: 'gpt-old', value: 'gpt-old' }],
                }),
                session({
                    id: 'new-claude',
                    machineId: 'mac',
                    flavor: 'claude',
                    activeAt: 40,
                    models: [{ code: 'claude-new', value: 'claude-new' }],
                }),
                session({
                    id: 'other-machine-codex',
                    machineId: 'linux',
                    flavor: 'codex',
                    activeAt: 50,
                    models: [{ code: 'gpt-linux', value: 'gpt-linux' }],
                }),
                session({
                    id: 'new-codex',
                    machineId: 'mac',
                    flavor: 'codex',
                    activeAt: 30,
                    models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' }],
                }),
            ],
            selectedMachineId: 'mac',
            agent: 'codex',
            codexAccountProfileId: null,
        });

        expect(latest?.models?.map((model) => model.code)).toEqual(['gpt-5.6-sol']);
    });

    it('ignores sessions without model metadata', () => {
        expect(getLatestSessionModelMetadata({
            sessions: [
                session({ id: 'empty', machineId: 'mac', flavor: 'codex', activeAt: 20 }),
            ],
            selectedMachineId: 'mac',
            agent: 'codex',
        })).toBeNull();
    });

    it('does not borrow a newer Magpie catalog for a bound ChatGPT account', () => {
        const latest = getLatestSessionModelMetadata({
            sessions: [
                session({ id: 'account', machineId: 'mac', flavor: 'codex', activeAt: 10,
                    codexAccountProfileId: 'account-a', models: [{ code: 'gpt-6.1-sol', value: 'Sol' }] }),
                session({ id: 'native', machineId: 'mac', flavor: 'codex', activeAt: 20,
                    models: [{ code: 'deepseek/DeepSeek-V4.1-Flash', value: 'DeepSeek' }] }),
                session({ id: 'other-account', machineId: 'mac', flavor: 'codex', activeAt: 30,
                    codexAccountProfileId: 'account-b', models: [{ code: 'gpt-other', value: 'Other' }] }),
            ],
            selectedMachineId: 'mac', agent: 'codex', codexAccountProfileId: 'account-a',
        });
        expect(latest?.models?.map(model => model.code)).toEqual(['gpt-6.1-sol']);
    });

    it('keeps native Magpie catalogs separate from bound account catalogs', () => {
        const latest = getLatestSessionModelMetadata({
            sessions: [
                session({ id: 'native', machineId: 'mac', flavor: 'codex', activeAt: 10,
                    models: [{ code: 'group/daily-auto', value: 'Daily' }] }),
                session({ id: 'account', machineId: 'mac', flavor: 'codex', activeAt: 20,
                    codexAccountProfileId: 'account-a', models: [{ code: 'gpt-6.1-sol', value: 'Sol' }] }),
            ],
            selectedMachineId: 'mac', agent: 'codex', codexAccountProfileId: null,
        });
        expect(latest?.models?.map(model => model.code)).toEqual(['group/daily-auto']);
    });

    it('waits for a known machine connection instead of borrowing any Codex catalog', () => {
        const sessions = [session({ id: 'native', machineId: 'mac', flavor: 'codex', activeAt: 10,
            models: [{ code: 'group/daily-auto', value: 'Daily' }] })];
        expect(getLatestSessionModelMetadata({ sessions, selectedMachineId: 'mac', agent: 'codex' })).toBeNull();
        expect(getLatestSessionModelMetadata({ sessions, selectedMachineId: null, agent: 'codex', codexAccountProfileId: null })).toBeNull();
        expect(getLatestSessionModelMetadata({ sessions, selectedMachineId: 'mac', agent: 'codex', codexAccountProfileId: 'new-account' })).toBeNull();
    });
});
