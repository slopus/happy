import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import tweetnacl from 'tweetnacl';
import { log } from '@/utils/log';

let secretKey: Uint8Array | null = null;
let initialized = false;

function ensureKey(): Uint8Array | null {
    if (initialized) return secretKey;
    initialized = true;

    if (process.env.DEV_AUTH_ENABLED !== 'true') return null;

    const happyHome = (process.env.HAPPY_HOME_DIR || '~/.happy').replace(/^~/, os.homedir());
    const keyFile = path.join(happyHome, 'access.key');

    try {
        const raw = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
        if (raw.secret) {
            secretKey = new Uint8Array(Buffer.from(raw.secret, 'base64'));
            log({ module: 'dev-encryption' }, `Loaded encryption key from ${keyFile}`);
        }
    } catch {
        log({ module: 'dev-encryption' }, `Could not read ${keyFile} — chat decryption unavailable`);
    }

    return secretKey;
}

export function devEncrypt(data: unknown): string | null {
    const key = ensureKey();
    if (!key) return null;

    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
    const encrypted = tweetnacl.secretbox(plaintext, nonce, key);
    const bundle = new Uint8Array(nonce.length + encrypted.length);
    bundle.set(nonce);
    bundle.set(encrypted, nonce.length);
    return Buffer.from(bundle).toString('base64');
}

export function devDecrypt(base64Ciphertext: string): unknown | null {
    const key = ensureKey();
    if (!key) return null;

    try {
        const data = new Uint8Array(Buffer.from(base64Ciphertext, 'base64'));
        const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
        const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
        const decrypted = tweetnacl.secretbox.open(encrypted, nonce, key);
        if (!decrypted) return null;
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

export function isDevEncryptionAvailable(): boolean {
    return ensureKey() !== null;
}
