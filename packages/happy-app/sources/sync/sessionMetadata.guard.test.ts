import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from './storageTypes';
import { updateEncryptedSessionMetadata } from './sessionMetadata';
import { withMessageOptionResponse } from './messageOptionResponses';

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: mocks.emit } }));
const metadata = { path: '/project', host: 'synthetic', lastUserMessageAt: 10 };
const encode = (value: unknown) => JSON.stringify(value);
const crypto = () => ({ encryptRaw: vi.fn(async (value: unknown) => encode(value)), decryptRaw: vi.fn(async (value: string) => JSON.parse(value)) }) as any;
const update = (value: Metadata) => (value.lastUserMessageAt ?? 0) >= 20 ? value : { ...value, lastUserMessageAt: 20 };

describe('user activity metadata ownership', () => {
    beforeEach(() => vi.clearAllMocks());
    it('merges a newer title on conflict without reducing a newer user clock', async () => {
        mocks.emit.mockResolvedValueOnce({ result: 'version-mismatch', version: 5, metadata: encode({ ...metadata, name: 'new title', lastUserMessageAt: 30 }) });
        const result = await updateEncryptedSessionMetadata('session', metadata, 1, crypto(), update);
        expect(result).toMatchObject({ version: 5, metadata: { name: 'new title', lastUserMessageAt: 30 } });
        expect(mocks.emit).toHaveBeenCalledTimes(1);
    });
    it('re-applies only the user clock over concurrent metadata edits', async () => {
        mocks.emit.mockResolvedValueOnce({ result: 'version-mismatch', version: 5, metadata: encode({ ...metadata, name: 'new title' }) });
        mocks.emit.mockImplementationOnce(async (_event, payload) => ({ result: 'success', version: 6, metadata: payload.metadata }));
        const result = await updateEncryptedSessionMetadata('session', metadata, 1, crypto(), update);
        expect(result).toMatchObject({ version: 6, metadata: { name: 'new title', lastUserMessageAt: 20 } });
    });
    it('does not emit ciphertext after account ownership changes during encryption', async () => {
        let current = true;
        const encryption = crypto(); encryption.encryptRaw.mockImplementationOnce(async (value: unknown) => { current = false; return encode(value); });
        await expect(updateEncryptedSessionMetadata('session', metadata, 1, encryption, update, 3, () => { if (!current) throw new Error('owner-changed'); })).rejects.toThrow('owner-changed');
        expect(mocks.emit).not.toHaveBeenCalled();
    });
    it('rejects a response when ownership changes before the metadata ACK', async () => {
        let current = true;
        mocks.emit.mockImplementationOnce(async (_event, payload) => { current = false; return { result: 'success', version: 2, metadata: payload.metadata }; });
        const encryption = crypto();
        await expect(updateEncryptedSessionMetadata('session', metadata, 1, encryption, update, 3, () => { if (!current) throw new Error('owner-changed'); })).rejects.toThrow('owner-changed');
        expect(encryption.decryptRaw).not.toHaveBeenCalled();
    });
});


describe('option receipt metadata ownership', () => {
    beforeEach(() => vi.clearAllMocks());
    const addReceipt = (value: Metadata) => withMessageOptionResponse(value, 'wire-question:text:0', {
        status: 'answered', answer: 'A', updatedAt: 20,
    });
    it('does not emit a receipt encrypted after its account owner was replaced', async () => {
        let current = true;
        const encryption = crypto();
        encryption.encryptRaw.mockImplementationOnce(async (value: unknown) => { current = false; return encode(value); });
        await expect(updateEncryptedSessionMetadata('session', metadata, 1, encryption, addReceipt, 3,
            () => { if (!current) throw new Error('owner-changed'); })).rejects.toThrow('owner-changed');
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(metadata).not.toHaveProperty('messageOptionResponses');
    });
    it('does not return a receipt to its caller when the owner changes while decrypting an ACK', async () => {
        let current = true;
        const encryption = crypto();
        mocks.emit.mockImplementationOnce(async (_event, payload) => ({ result: 'success', version: 2, metadata: payload.metadata }));
        encryption.decryptRaw.mockImplementationOnce(async (value: string) => { current = false; return JSON.parse(value); });
        const applyToStore = vi.fn();
        const writing = updateEncryptedSessionMetadata('session', metadata, 1, encryption, addReceipt, 3,
            () => { if (!current) throw new Error('owner-changed'); }).then(applyToStore);
        await expect(writing).rejects.toThrow('owner-changed');
        expect(applyToStore).not.toHaveBeenCalled();
        expect(metadata).not.toHaveProperty('messageOptionResponses');
    });
    it('does not retry a receipt write after the owner changes during conflict decryption', async () => {
        let current = true;
        const encryption = crypto();
        mocks.emit.mockResolvedValueOnce({ result: 'version-mismatch', version: 5, metadata: encode({ ...metadata, name: 'new title' }) });
        encryption.decryptRaw.mockImplementationOnce(async (value: string) => { current = false; return JSON.parse(value); });
        await expect(updateEncryptedSessionMetadata('session', metadata, 1, encryption, addReceipt, 3,
            () => { if (!current) throw new Error('owner-changed'); })).rejects.toThrow('owner-changed');
        expect(mocks.emit).toHaveBeenCalledTimes(1);
    });
});
