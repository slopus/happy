#!/usr/bin/env node
/**
 * Direct happy account registration — no browser, no QR pairing.
 *
 * Useful when you self-host the server and just want to bootstrap a brand-new
 * account from the CLI. Skips the entire `happy auth login` → webapp →
 * /terminal/connect flow. Just POSTs to /v1/auth with a fresh keypair and
 * writes the resulting JWT + secret to ~/.happy/access.key in the format the
 * CLI loads at startup.
 *
 * After running, `happy doctor` reports "Authenticated", and the same
 * access.key can be copied to other machines (`scp`) to put them on the same
 * account.
 *
 * Usage (with HAPPY_HOME_DIR / settings.json already pointing at your server):
 *   node scripts/happy-register.mjs
 *
 * Or with an explicit server URL (overrides settings.json):
 *   node scripts/happy-register.mjs http://user:pass@host:port
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// Reuse tweetnacl from the globally-installed `happy` package so we don't need
// a separate npm install. If the global happy isn't installed, fall back to
// require('tweetnacl') relative to this script — useful in the monorepo where
// pnpm install hoists it.
function loadTweetnacl() {
    const candidates = [
        // global happy (Windows / Unix npm prefix)
        ...((process.env.APPDATA && [join(process.env.APPDATA, 'npm', 'node_modules', 'happy', 'node_modules', 'tweetnacl')]) || []),
        join(process.env.HOME || homedir(), '.npm-global', 'lib', 'node_modules', 'happy', 'node_modules', 'tweetnacl'),
        '/usr/local/lib/node_modules/happy/node_modules/tweetnacl',
        'tweetnacl', // monorepo fallback
    ];
    for (const c of candidates) {
        try { return require_(c); } catch {}
    }
    console.error('Could not find tweetnacl. Install via:');
    console.error('  npm install -g happy@1.1.10-beta.4    (gets it transitively)');
    console.error('  OR  npm install tweetnacl   (in this directory)');
    process.exit(1);
}

const nacl = loadTweetnacl();

// Resolve happy home dir + settings.json
const happyHome = process.env.HAPPY_HOME_DIR
    ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
    : join(homedir(), '.happy');
const settingsFile = join(happyHome, 'settings.json');
const accessKeyFile = join(happyHome, 'access.key');

// Resolve server URL: CLI arg > env var > settings.json > prod default
let serverUrl = process.argv[2]
    || process.env.HAPPY_SERVER_URL
    || (existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, 'utf8'))?.serverUrl ?? null) : null);
if (!serverUrl) {
    console.error('No server URL — pass it as an argument or set serverUrl in ~/.happy/settings.json');
    process.exit(1);
}
serverUrl = serverUrl.replace(/\/+$/, ''); // trim trailing slash

// Node 22's undici fetch rejects URLs with embedded credentials, so split them
// out and send via Authorization header instead. URL-decode the user/pass.
function splitCredentials(url) {
    const m = url.match(/^(https?:\/\/)([^@/]+)@(.+)$/);
    if (!m) return { url, authHeader: null };
    const [user, ...rest] = m[2].split(':');
    const pass = rest.join(':');
    const decUser = decodeURIComponent(user);
    const decPass = decodeURIComponent(pass);
    return {
        url: `${m[1]}${m[3]}`,
        authHeader: 'Basic ' + Buffer.from(`${decUser}:${decPass}`).toString('base64'),
    };
}

const { url: cleanServerUrl, authHeader } = splitCredentials(serverUrl);
serverUrl = cleanServerUrl;

if (existsSync(accessKeyFile)) {
    console.error(`Refusing to overwrite existing ${accessKeyFile}.`);
    console.error('Delete it first (or run `happy auth logout`) if you really want to re-register.');
    process.exit(1);
}

// Generate a fresh keypair (sign.keyPair.fromSeed matches authChallenge in
// packages/happy-cli/src/api/encryption.ts).
function getRandomBytes(n) {
    const arr = new Uint8Array(n);
    require_('node:crypto').webcrypto.getRandomValues(arr);
    return arr;
}

const secret = getRandomBytes(32);
const keypair = nacl.sign.keyPair.fromSeed(secret);
const challenge = getRandomBytes(32);
const signature = nacl.sign.detached(challenge, keypair.secretKey);

const toB64 = (u8) => Buffer.from(u8).toString('base64');

console.log(`Registering against ${serverUrl}...`);

const res = await fetch(`${serverUrl}/v1/auth`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Happy-Client': 'cli/manual-register',
        ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
    body: JSON.stringify({
        challenge: toB64(challenge),
        publicKey: toB64(keypair.publicKey),
        signature: toB64(signature),
    }),
});

if (!res.ok) {
    console.error(`HTTP ${res.status} from /v1/auth`);
    console.error(await res.text());
    process.exit(1);
}

const data = await res.json();
if (!data.success || !data.token) {
    console.error('Server replied without success/token:', data);
    process.exit(1);
}

// Write the access.key in the legacy format the CLI expects.
if (!existsSync(happyHome)) mkdirSync(happyHome, { recursive: true });
writeFileSync(accessKeyFile, JSON.stringify({
    secret: toB64(secret),
    token: data.token,
}, null, 2), { mode: 0o600 });

console.log(`✓ Wrote credentials to ${accessKeyFile}`);
console.log(`  Public key: ${toB64(keypair.publicKey).slice(0, 16)}...`);
console.log(`  Token:      ${String(data.token).slice(0, 24)}...`);
console.log('');
console.log('Next: copy this file to your other machines to put them on the same account:');
console.log(`  scp ${accessKeyFile} <user>@<host>:~/.happy/access.key`);
