import { describe, expect, it, vi } from 'vitest';
import { prepareCodexConversationConfiguration } from './codexConversationPreparation';

const configuration = { model: 'target-model', effort: 'high' as const, permissionMode: 'read-only' as const };
const prepared = { threadId: 'target-thread', model: 'target-model', reasoningEffort: 'high' as const };

describe('Codex native configuration before conversation metadata acknowledgement', () => {
    it('retains the metadata and business boundary until the native thread acknowledges configuration', async () => {
        let acknowledge!: (value: typeof prepared) => void;
        const nativeAck = new Promise<typeof prepared>(resolve => { acknowledge = resolve; });
        const client = { sandboxEnabled: false, prepareThreadConfiguration: vi.fn(() => nativeAck) };
        const metadataAck = vi.fn(async () => {});
        const pending = prepareCodexConversationConfiguration(configuration, { client, assertCurrent: () => {}, acknowledge: metadataAck });
        expect(metadataAck).not.toHaveBeenCalled();
        expect(client.prepareThreadConfiguration).toHaveBeenCalledWith({ model: 'target-model', effort: 'high', approvalPolicy: 'never', sandbox: 'read-only' }, expect.any(Function));
        acknowledge(prepared); await pending;
        expect(metadataAck).toHaveBeenCalledExactlyOnceWith(prepared);
    });

    it('does not publish an applied configuration when native preparation fails', async () => {
        const client = { sandboxEnabled: false, prepareThreadConfiguration: vi.fn(async () => { throw new Error('Native Codex configuration was not acknowledged'); }) };
        const metadataAck = vi.fn(async () => {});
        await expect(prepareCodexConversationConfiguration(configuration, { client, assertCurrent: () => {}, acknowledge: metadataAck }))
            .rejects.toThrow('Native Codex configuration was not acknowledged');
        expect(metadataAck).not.toHaveBeenCalled();
    });

    it('discards a native receipt that arrives after the candidate loses ownership', async () => {
        let current = true;
        const client = { sandboxEnabled: false, prepareThreadConfiguration: vi.fn(async () => { current = false; return prepared; }) };
        const metadataAck = vi.fn(async () => {});
        await expect(prepareCodexConversationConfiguration(configuration, { client, assertCurrent: () => { if (!current) throw new Error('Candidate changed'); }, acknowledge: metadataAck }))
            .rejects.toThrow('Candidate changed');
        expect(metadataAck).not.toHaveBeenCalled();
    });
});
