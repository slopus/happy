#!/usr/bin/env node
/**
 * Programmatic auth for local dev: creates an account on the server
 * and writes credentials to ~/.happy/access.key so the CLI daemon can start
 * without needing the mobile app QR code flow.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const serverUrl = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
const happyHome = (process.env.HAPPY_HOME_DIR || '~/.happy').replace(/^~/, os.homedir());

async function main() {
    // Check server is reachable
    try {
        const res = await fetch(`${serverUrl}/`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
    } catch (e) {
        console.error(`Server not reachable at ${serverUrl}. Start it first.`);
        process.exit(1);
    }

    // Check if already authenticated
    const keyFile = path.join(happyHome, 'access.key');
    if (fs.existsSync(keyFile)) {
        console.log(`Already authenticated (${keyFile} exists).`);
        console.log('Delete it first if you want to re-authenticate.');
        process.exit(0);
    }

    // Generate Ed25519 keypair and sign a challenge
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const rawPublicKey = Buffer.from(jwk.x || '', 'base64url');
    const challenge = crypto.randomBytes(32);
    const signature = crypto.sign(null, challenge, privateKey);

    const toBase64 = (buf) => Buffer.from(buf).toString('base64');

    // Authenticate
    const authRes = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            publicKey: toBase64(rawPublicKey),
            challenge: toBase64(challenge),
            signature: toBase64(signature),
        }),
    });

    if (!authRes.ok) {
        console.error(`Auth failed: ${authRes.status} ${await authRes.text()}`);
        process.exit(1);
    }

    const { token } = await authRes.json();
    const secret = crypto.randomBytes(32);

    // Write credentials
    fs.mkdirSync(happyHome, { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify({
        secret: toBase64(secret),
        token,
    }, null, 2));

    // Write settings with machine ID
    const settingsFile = path.join(happyHome, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
        fs.writeFileSync(settingsFile, JSON.stringify({
            schemaVersion: 2,
            onboardingCompleted: true,
            machineId: crypto.randomUUID(),
        }, null, 2));
    }

    console.log(`Authenticated successfully.`);
    console.log(`  Credentials: ${keyFile}`);
    console.log(`  Server:      ${serverUrl}`);
    console.log(`\nYou can now run: make cli`);
}

main().catch(e => { console.error(e); process.exit(1); });
