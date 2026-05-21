#!/usr/bin/env node
/**
 * One-shot helper: writes the local CLI's auth credentials into the
 * HappyDesktop Chrome profile's localStorage so the browser webapp
 * launches already-authenticated. Run once per profile; persists
 * across reboots in the profile's leveldb on disk.
 *
 * Why needed:
 *   Each browser origin has isolated localStorage. The webapp's
 *   "Create Account" path *mints a fresh server account* — it doesn't
 *   import the user's existing identity from ~/.happy/access.key.
 *   This script bridges that gap.
 *
 * Usage:
 *   # From the repo root, after .env is in place and Chrome has been
 *   # closed on the HappyDesktop profile:
 *   node scripts/inject-happy-auth-windows.mjs
 *
 *   # Override target URL or profile path via env:
 *   HAPPY_TARGET_URL=https://192.0.2.10:3007/multi node ...
 *   HAPPY_PROFILE_DIR='C:\Users\<you>\AppData\Local\HappyDesktop' node ...
 *
 * What happens:
 *   1. Spawns Chrome with --remote-debugging-port + --user-data-dir + --app
 *   2. Connects to the just-spawned page via Chrome DevTools Protocol
 *   3. localStorage.setItem('auth_credentials', <from access.key>)
 *   4. Reloads the page; verifies; exits
 *   5. Chrome keeps running with your authenticated session
 *
 * Safe to re-run: it'll just overwrite the same key with the same value.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
const CHROME = CHROME_CANDIDATES.find(existsSync);
if (!CHROME) {
    console.error('Chrome not found in any standard location.');
    process.exit(1);
}

const PROFILE = process.env.HAPPY_PROFILE_DIR
    || join(process.env.LOCALAPPDATA || (homedir() + '\\AppData\\Local'), 'HappyDesktop');

const TARGET_URL = process.env.HAPPY_TARGET_URL
    || process.env.HAPPY_TLS_URL
    || (process.env.HAPPY_TLS_HOST && process.env.HAPPY_TLS_PORT
        ? `https://${process.env.HAPPY_TLS_HOST}:${process.env.HAPPY_TLS_PORT}/multi`
        : null);
if (!TARGET_URL) {
    console.error('Need HAPPY_TARGET_URL (or HAPPY_TLS_URL, or HAPPY_TLS_HOST+HAPPY_TLS_PORT) — see .env.example');
    process.exit(1);
}

const KEY_PATH = process.env.HAPPY_ACCESS_KEY_PATH
    || join(homedir(), '.happy', 'access.key');
if (!existsSync(KEY_PATH)) {
    console.error(`No access.key at ${KEY_PATH}. Run scripts/happy-register.mjs first.`);
    process.exit(1);
}

const DEBUG_PORT = parseInt(process.env.HAPPY_DEBUG_PORT || '19222', 10);

const keyJson = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
const credsJson = JSON.stringify({ token: keyJson.token, secret: keyJson.secret });

console.log(`Chrome:       ${CHROME}`);
console.log(`Profile dir:  ${PROFILE}`);
console.log(`Target URL:   ${TARGET_URL}`);
console.log(`Access key:   ${KEY_PATH}`);
console.log();

const chrome = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--ignore-certificate-errors',
    `--app=${TARGET_URL}`,
], { detached: true, stdio: 'ignore' });
chrome.unref();

async function waitForCdp(maxMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
            if (r.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('CDP did not come up — is Chrome already running on this profile? Close it first.');
}

async function waitForPageTab(maxMs = 15000) {
    const targetOrigin = new URL(TARGET_URL).origin;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        const tabs = await fetch(`http://localhost:${DEBUG_PORT}/json`).then(r => r.json());
        const page = tabs.find(t => t.type === 'page' && t.url.startsWith(targetOrigin));
        if (page && page.webSocketDebuggerUrl) return page;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('No matching page tab appeared in time');
}

async function cdp(ws, msg) {
    return await new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const handler = (e) => {
            const data = JSON.parse(e.data);
            if (data.id === id) {
                ws.removeEventListener('message', handler);
                data.error ? reject(new Error(data.error.message)) : resolve(data.result);
            }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, ...msg }));
    });
}

(async () => {
    await waitForCdp();
    console.log('CDP up. Finding the Happy tab...');
    const page = await waitForPageTab();
    console.log(`Found: ${page.url}`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    // Wait briefly for the document to be ready (otherwise localStorage.setItem
    // can hit before the page has navigated to its real origin).
    await new Promise(r => setTimeout(r, 1500));

    await cdp(ws, {
        method: 'Runtime.evaluate',
        params: {
            expression: `localStorage.setItem('auth_credentials', ${JSON.stringify(credsJson)}); 'ok'`,
            returnByValue: true,
        },
    });
    console.log('auth_credentials written.');

    await cdp(ws, { method: 'Page.reload' });
    await new Promise(r => setTimeout(r, 4000));

    const verify = await cdp(ws, {
        method: 'Runtime.evaluate',
        params: {
            expression: 'JSON.stringify({hasAuth: !!localStorage.getItem("auth_credentials"), bodyLen: document.body.innerText.length})',
            returnByValue: true,
        },
    });
    console.log('Verify:', verify.result.value);

    ws.close();
    console.log('\n✓ Done. Persists in the Chrome profile leveldb across reboots.');
    console.log('  Future launches of the Happy (Multi) shortcut land already-authenticated.');
})().catch((e) => {
    console.error('Inject failed:', e.message);
    process.exit(1);
});
