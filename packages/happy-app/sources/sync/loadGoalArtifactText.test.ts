import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { encryptBlob } from '@/encryption/blob';
import { loadGoalArtifactText } from './loadGoalArtifactText';
const mocks = vi.hoisted(() => ({ download: vi.fn(), credentials: { token: 'test-token' }, key: new Uint8Array(32).fill(7) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)) }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: require('libsodium-wrappers') }));
vi.mock('./apiAttachments', () => ({ downloadEncryptedAttachment: mocks.download }));
vi.mock('./sync', () => ({ sync: { getCredentials: () => mocks.credentials, encryption: { getSessionBlobKey: () => mocks.key } } }));
const content = '<!doctype html><h1>视频拆解原文</h1>' + 'x'.repeat(4704647);
const bytes = new TextEncoder().encode(content);
const attachment = { ref: 'private/report', name: 'report.html', kind: 'file' as const, size: bytes.byteLength, mimeType: 'text/html', encrypted: true };
beforeEach(() => mocks.download.mockReset());
beforeAll(async () => { await sodium.ready; });
describe('Goal text original bytes', () => {
    it('decrypts a 4.7 MB original with the session key without losing UTF-8 or trailing bytes', async () => {
        mocks.download.mockResolvedValue(encryptBlob(bytes, mocks.key));
        expect((await loadGoalArtifactText('session-1', attachment)) === content).toBe(true);
        expect(mocks.download).toHaveBeenCalledWith(mocks.credentials, 'session-1', attachment.ref);
    });
    it('rejects size drift, binary text and invalid UTF-8', async () => {
        for (const raw of [new Uint8Array([0, 1]), new Uint8Array([0xff])]) {
            mocks.download.mockResolvedValue(encryptBlob(raw, mocks.key));
            await expect(loadGoalArtifactText('s1', { ...attachment, size: raw.length })).rejects.toThrow();
        }
        mocks.download.mockResolvedValue(encryptBlob(new Uint8Array([65]), mocks.key));
        await expect(loadGoalArtifactText('s1', attachment)).rejects.toThrow('size mismatch');
    });
    it('rejects plaintext and oversized descriptors before downloading', async () => {
        await expect(loadGoalArtifactText('s1', { ...attachment, encrypted: false })).rejects.toThrow();
        await expect(loadGoalArtifactText('s1', { ...attachment, size: 16 * 1024 * 1024 + 1 })).rejects.toThrow();
        expect(mocks.download).not.toHaveBeenCalled();
    });
    it('discards a download cancelled while it was in flight', async () => {
        const abort = new AbortController();
        mocks.download.mockImplementation(async () => { abort.abort(); return encryptBlob(bytes, mocks.key); });
        await expect(loadGoalArtifactText('s1', attachment, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
});
