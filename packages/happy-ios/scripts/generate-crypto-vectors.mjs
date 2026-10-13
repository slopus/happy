#!/usr/bin/env node
// Generates Tests/HappyCryptoTests/Fixtures/crypto-vectors.json.
//
// The vectors come from the same implementations the rest of Happy uses:
// tweetnacl (server, CLI, happy-agent) and node:crypto (happy-agent's
// AES-256-GCM and HMAC-SHA512). The Swift tests check that HappyCrypto
// produces and opens exactly these bytes, so the iOS app stays wire
// compatible with every other client.
//
// Usage (from the repo root, after `pnpm install`):
//   node packages/happy-ios/scripts/generate-crypto-vectors.mjs
// To use a tweetnacl from somewhere else:
//   TWEETNACL_PATH=/path/to/node_modules/tweetnacl node .../generate-crypto-vectors.mjs
//
// Output is deterministic: all "random" inputs come from a SHA-256 counter.

import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const require = createRequire(path.join(repoRoot, 'packages/happy-cli/package.json'));
const nacl = process.env.TWEETNACL_PATH ? require(process.env.TWEETNACL_PATH) : require('tweetnacl');

let counter = 0;
function bytes(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
        const block = createHash('sha256').update(`happy-ios-vectors-${counter++}`).digest();
        const take = Math.min(block.length, n - filled);
        out.set(block.subarray(0, take), filled);
        filled += take;
    }
    return out;
}

const b64 = (u8) => Buffer.from(u8).toString('base64');
const b64url = (u8) => Buffer.from(u8).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

// --- Key tree (packages/happy-app/sources/encryption/deriveKey.ts) ---
const hmac512 = (key, data) => new Uint8Array(createHmac('sha512', key).update(data).digest());
function deriveKey(master, usage, pathParts) {
    let I = hmac512(new TextEncoder().encode(usage + ' Master Seed'), master);
    let state = { key: I.slice(0, 32), chainCode: I.slice(32) };
    for (const index of pathParts) {
        I = hmac512(state.chainCode, concat(new Uint8Array([0]), new TextEncoder().encode(index)));
        state = { key: I.slice(0, 32), chainCode: I.slice(32) };
    }
    return state.key;
}

// libsodium crypto_box_seed_keypair: secret = SHA-512(seed)[0..32]
function boxSeedKeyPair(seed) {
    const sk = new Uint8Array(createHash('sha512').update(seed).digest()).slice(0, 32);
    return nacl.box.keyPair.fromSecretKey(sk);
}

// --- Secret key backup (packages/happy-app/sources/auth/secretKeyBackup.ts) ---
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function bytesToBase32(u8) {
    let result = '';
    let buffer = 0;
    let bufferLength = 0;
    for (const byte of u8) {
        buffer = (buffer << 8) | byte;
        bufferLength += 8;
        while (bufferLength >= 5) {
            bufferLength -= 5;
            result += BASE32[(buffer >> bufferLength) & 0x1f];
        }
    }
    if (bufferLength > 0) result += BASE32[(buffer << (5 - bufferLength)) & 0x1f];
    return result;
}
function formatBackup(u8) {
    const s = bytesToBase32(u8);
    const groups = [];
    for (let i = 0; i < s.length; i += 5) groups.push(s.slice(i, i + 5));
    return groups.join('-');
}

const vectors = {
    generator: 'packages/happy-ios/scripts/generate-crypto-vectors.mjs',
    base64: [],
    hmacSha512: [],
    deriveKey: [],
    accountKeys: [],
    secretBox: [],
    box: [],
    aesGcm: [],
    signing: [],
    secretKeyBackup: [],
};

for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64]) {
    const data = bytes(n);
    vectors.base64.push({ data: Buffer.from(data).toString('hex'), base64: b64(data), base64url: b64url(data) });
}

for (const [keyLen, dataLen] of [[0, 0], [32, 1], [64, 100], [128, 33], [200, 300]]) {
    const key = bytes(keyLen);
    const data = bytes(dataLen);
    vectors.hmacSha512.push({ key: b64(key), data: b64(data), mac: b64(hmac512(key, data)) });
}

for (const [usage, pathParts] of [
    ['Happy EnCoder', ['content']],
    ['Happy Coder', ['analytics', 'id']],
    ['Happy Coder', ['analytics', 'provider-account']],
    ['Happy Blobs', ['master']],
    ['Happy Blobs', ['session']],
    ['Happy Blobs', []],
]) {
    const master = bytes(32);
    vectors.deriveKey.push({ master: b64(master), usage, path: pathParts, key: b64(deriveKey(master, usage, pathParts)) });
}

for (let i = 0; i < 3; i++) {
    const secret = bytes(32);
    const contentSeed = deriveKey(secret, 'Happy EnCoder', ['content']);
    const contentKeyPair = boxSeedKeyPair(contentSeed);
    const anonID = Buffer.from(deriveKey(secret, 'Happy Coder', ['analytics', 'id'])).toString('hex').slice(0, 16).toLowerCase();
    const signingKeyPair = nacl.sign.keyPair.fromSeed(secret);

    // A per-record data encryption key, wrapped the way the server stores it:
    // version byte 0 + box bundle sealed to the account content public key.
    const dataKey = bytes(32);
    const ephemeralSecret = bytes(32);
    const ephemeral = nacl.box.keyPair.fromSecretKey(ephemeralSecret);
    const nonce = bytes(24);
    const sealed = nacl.box(dataKey, nonce, contentKeyPair.publicKey, ephemeral.secretKey);
    const wrappedDataKey = concat(new Uint8Array([0]), ephemeral.publicKey, nonce, sealed);

    // Terminal connect, v2: box([0] || contentPublicKey) to the terminal's key.
    const terminalSecret = bytes(32);
    const terminal = nacl.box.keyPair.fromSecretKey(terminalSecret);

    vectors.accountKeys.push({
        secret: b64(secret),
        secretBase64url: b64url(secret),
        contentKeySeed: b64(contentSeed),
        contentSecretKey: b64(contentKeyPair.secretKey),
        contentPublicKey: b64(contentKeyPair.publicKey),
        anonID,
        signingPublicKey: b64(signingKeyPair.publicKey),
        dataKey: b64(dataKey),
        wrappedDataKey: b64(wrappedDataKey),
        terminalSecretKey: b64(terminalSecret),
        terminalPublicKey: b64(terminal.publicKey),
    });
}

for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 1000, 4096]) {
    const key = bytes(32);
    const nonce = bytes(24);
    const plaintext = bytes(n);
    const boxed = nacl.secretbox(plaintext, nonce, key);
    vectors.secretBox.push({ key: b64(key), nonce: b64(nonce), plaintext: b64(plaintext), bundle: b64(concat(nonce, boxed)) });
}

for (const n of [0, 1, 32, 33, 100, 1000]) {
    const recipientSeed = bytes(32);
    const recipient = boxSeedKeyPair(recipientSeed);
    const ephemeralSecret = bytes(32);
    const ephemeral = nacl.box.keyPair.fromSecretKey(ephemeralSecret);
    const nonce = bytes(24);
    const plaintext = bytes(n);
    const boxed = nacl.box(plaintext, nonce, recipient.publicKey, ephemeral.secretKey);
    vectors.box.push({
        recipientSeed: b64(recipientSeed),
        recipientSecretKey: b64(recipient.secretKey),
        recipientPublicKey: b64(recipient.publicKey),
        ephemeralSecretKey: b64(ephemeralSecret),
        nonce: b64(nonce),
        plaintext: b64(plaintext),
        bundle: b64(concat(ephemeral.publicKey, nonce, boxed)),
    });
}

for (const value of [
    { t: 'hello' },
    { role: 'session', content: { id: 'msg_01', time: 1739347230000, role: 'agent', ev: { t: 'text', text: 'Grüße 👋 — "quotes" \\ backslash' } } },
    'plain string',
    [1, 2, 3],
    null,
]) {
    const key = bytes(32);
    const nonce = bytes(12);
    const json = JSON.stringify(value);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([cipher.update(Buffer.from(json, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    vectors.aesGcm.push({ key: b64(key), nonce: b64(nonce), json, bundle: b64(concat(new Uint8Array([0]), nonce, ct, tag)) });
}

for (const n of [0, 32, 100]) {
    const seed = bytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const message = bytes(n);
    vectors.signing.push({
        seed: b64(seed),
        publicKey: b64(kp.publicKey),
        message: b64(message),
        signature: b64(nacl.sign.detached(message, kp.secretKey)),
    });
}

for (let i = 0; i < 4; i++) {
    const key = bytes(32);
    vectors.secretKeyBackup.push({ secretBase64url: b64url(key), formatted: formatBackup(key) });
}

const out = path.resolve(here, '../Tests/HappyCryptoTests/Fixtures/crypto-vectors.json');
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)}`);
