import { describe, it, expect } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decryptBlob, encrypt, getRandomBytes, tryDecrypt } from './encryption';

describe('decryptBlob', () => {
    it('decrypts a blob encrypted with NaCl secretbox', () => {
        const key = getRandomBytes(32);
        const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = tweetnacl.secretbox(plaintext, nonce, key);

        // Wire format: nonce + ciphertext
        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce, 0);
        bundle.set(ciphertext, nonce.length);

        const decrypted = decryptBlob(bundle, key);
        expect(decrypted).not.toBeNull();
        expect(decrypted).toEqual(plaintext);
    });

    it('returns null for wrong key', () => {
        const key = getRandomBytes(32);
        const wrongKey = getRandomBytes(32);
        const plaintext = new Uint8Array([10, 20, 30]);
        const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = tweetnacl.secretbox(plaintext, nonce, key);

        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce, 0);
        bundle.set(ciphertext, nonce.length);

        expect(decryptBlob(bundle, wrongKey)).toBeNull();
    });

    it('returns null for truncated bundle', () => {
        const key = getRandomBytes(32);
        const tooShort = new Uint8Array(10); // Less than nonce (24) + auth tag (16)
        expect(decryptBlob(tooShort, key)).toBeNull();
    });

    it('round-trips binary data of various sizes', () => {
        const key = getRandomBytes(32);
        for (const size of [0, 1, 255, 1024, 65536]) {
            const data = getRandomBytes(size);
            const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
            const encrypted = tweetnacl.secretbox(data, nonce, key);
            const bundle = new Uint8Array(nonce.length + encrypted.length);
            bundle.set(nonce, 0);
            bundle.set(encrypted, nonce.length);

            const decrypted = decryptBlob(bundle, key);
            expect(decrypted).toEqual(data);
        }
    });
});

// aplus §6-1 Phase 3b (aplus-dev-studio specs/20260818-e2ee-account-keypair) —
// getOrCreateMachine 이 보내는 dataEncryptionKey 봉투의 단일 조립 지점.
// 포맷: [version 0x00 | ephemeralPub(32) | nonce(24) | box ct] — dataKey
// 모드가 이미 쓰던 것과 바이트 단위로 동일해야 한다.
describe('wrapDataEncryptionKey', () => {
    it('wraps a machine key so the recipient private key can unwrap it', async () => {
        const { wrapDataEncryptionKey } = await import('./encryption');
        const recipient = tweetnacl.box.keyPair();
        const machineKey = getRandomBytes(32);

        const bundle = wrapDataEncryptionKey(machineKey, recipient.publicKey);

        expect(bundle[0]).toBe(0); // version byte
        const ephemeralPub = bundle.slice(1, 33);
        const nonce = bundle.slice(33, 33 + 24);
        const ct = bundle.slice(33 + 24);
        const opened = tweetnacl.box.open(ct, nonce, ephemeralPub, recipient.secretKey);
        expect(opened).not.toBeNull();
        expect(new Uint8Array(opened!)).toEqual(machineKey);
    });

    it('produces a fresh ephemeral key per call (no bundle reuse)', async () => {
        const { wrapDataEncryptionKey } = await import('./encryption');
        const recipient = tweetnacl.box.keyPair();
        const machineKey = getRandomBytes(32);
        const a = wrapDataEncryptionKey(machineKey, recipient.publicKey);
        const b = wrapDataEncryptionKey(machineKey, recipient.publicKey);
        expect(Buffer.from(a).toString('base64')).not.toBe(Buffer.from(b).toString('base64'));
    });
});

// aplus §6-1 트랙 B B1 (design-db1 §3.2) — 머신 키 이중 수신자 wrap 의
// 단일 조립 지점. 계정 몫 봉투는 upstream 그대로, 서버 몫 봉투는 서버
// 서비스 공개키가 알려진 경우에만 추가로 만든다. **세션 DEK 는 이 함수의
// 입력이 아니다** — machineKey 만 이중 wrap 된다.
describe('buildMachineKeyEnvelopes', () => {
    it('wraps the machine key for both the account and the server recipients', async () => {
        const { buildMachineKeyEnvelopes } = await import('./encryption');
        const account = tweetnacl.box.keyPair();
        const server = tweetnacl.box.keyPair();
        const machineKey = getRandomBytes(32);

        const envelopes = buildMachineKeyEnvelopes(
            { machineKey, accountPublicKey: account.publicKey },
            server.publicKey,
        );

        const unwrap = (bundle: Uint8Array, secretKey: Uint8Array) => {
            expect(bundle[0]).toBe(0);
            const opened = tweetnacl.box.open(
                bundle.slice(33 + 24), bundle.slice(33, 33 + 24), bundle.slice(1, 33), secretKey);
            expect(opened).not.toBeNull();
            return new Uint8Array(opened!);
        };
        expect(unwrap(envelopes.dataEncryptionKey!, account.secretKey)).toEqual(machineKey);
        expect(unwrap(envelopes.serverDataEncryptionKey!, server.secretKey)).toEqual(machineKey);
        // 교차 열람 불가 — 서버 개인키로 계정 몫 봉투를 못 연다 (반대도 동일).
        expect(tweetnacl.box.open(
            envelopes.dataEncryptionKey!.slice(33 + 24),
            envelopes.dataEncryptionKey!.slice(33, 33 + 24),
            envelopes.dataEncryptionKey!.slice(1, 33),
            server.secretKey,
        )).toBeNull();
    });

    it('omits the server envelope when no server public key is known', async () => {
        const { buildMachineKeyEnvelopes } = await import('./encryption');
        const account = tweetnacl.box.keyPair();
        const envelopes = buildMachineKeyEnvelopes(
            { machineKey: getRandomBytes(32), accountPublicKey: account.publicKey },
            null,
        );
        expect(envelopes.dataEncryptionKey).not.toBeNull();
        expect(envelopes.serverDataEncryptionKey).toBeNull();
    });

    it('returns both null when there is no machine key material (plain legacy)', async () => {
        const { buildMachineKeyEnvelopes } = await import('./encryption');
        const server = tweetnacl.box.keyPair();
        const envelopes = buildMachineKeyEnvelopes(null, server.publicKey);
        expect(envelopes.dataEncryptionKey).toBeNull();
        expect(envelopes.serverDataEncryptionKey).toBeNull();
    });
});

// RPC callers are authenticated only by the key that seals their params, so the
// receiver must be able to tell "this key opened it" apart from "it opened to
// null". `decrypt` returns null for both.
describe('tryDecrypt', () => {
    describe.each(['legacy', 'dataKey'] as const)('%s', (variant) => {
        it('returns the value sealed with the same key', () => {
            const key = getRandomBytes(32);
            expect(tryDecrypt(key, variant, encrypt(key, variant, { cwd: '/w' }))).toEqual({ ok: true, value: { cwd: '/w' } });
        });

        it('reports a sealed null as a successful open', () => {
            const key = getRandomBytes(32);
            expect(tryDecrypt(key, variant, encrypt(key, variant, null))).toEqual({ ok: true, value: null });
        });

        it('treats an authenticated empty plaintext as null', () => {
            const key = getRandomBytes(32);
            expect(tryDecrypt(key, variant, encrypt(key, variant, undefined))).toEqual({ ok: true, value: null });
        });

        it('fails for a payload sealed with another key', () => {
            const key = getRandomBytes(32);
            expect(tryDecrypt(key, variant, encrypt(getRandomBytes(32), variant, {}))).toEqual({ ok: false });
        });

        it('fails for a tampered payload', () => {
            const key = getRandomBytes(32);
            const sealed = encrypt(key, variant, { command: 'ls' });
            sealed[sealed.length - 1] ^= 0xff;
            expect(tryDecrypt(key, variant, sealed)).toEqual({ ok: false });
        });

        it('fails for random and truncated bytes', () => {
            const key = getRandomBytes(32);
            expect(tryDecrypt(key, variant, getRandomBytes(64))).toEqual({ ok: false });
            expect(tryDecrypt(key, variant, new Uint8Array(0))).toEqual({ ok: false });
        });
    });
});
