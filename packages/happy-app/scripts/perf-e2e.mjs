#!/usr/bin/env node
/**
 * Chat-list performance e2e against REAL sessions on a REAL simulator.
 *
 * Enforces docs/chat-list-acceptance.md section B. It owns the whole run:
 * starts Metro so it can read the app's console output, relaunches the dev
 * client on the booted simulator, waits for `[perf] recent-sessions`, then
 * deep-links through the N most recent sessions collecting `[perf]` timings.
 *
 * Requirements: a booted iOS simulator with com.slopus.happy.dev installed
 * and logged in. No other Metro on :8081.
 *
 *   node scripts/perf-e2e.mjs [--sessions 10] [--budget-first-commit 1200]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'com.slopus.happy.dev';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (
    a.startsWith('--') ? [a.slice(2), all[i + 1]] : []
)).filter((p) => p.length));
const SESSION_COUNT = Number(args['sessions'] ?? 10);
const BUDGETS = {
    worstCommitMs: Number(args['budget-worst-commit'] ?? 300),
    quietCommits: Number(args['budget-quiet-commits'] ?? 2),
    mountedMs: Number(args['budget-mounted'] ?? 2500),
    applyMessagesMs: Number(args['budget-apply'] ?? 50),
    settleMs: Number(args['settle'] ?? 8000),
};

function sim(...cmd) {
    return execFileSync('xcrun', ['simctl', ...cmd], { encoding: 'utf8' });
}

const log = (msg) => console.log(`[harness] ${msg}`);

// ---------------------------------------------------------------- Metro
log('starting metro (this owns the app log stream)');
const metro = spawn('npx', ['expo', 'start', '--dev-client'], {
    cwd: appRoot,
    // NOT CI mode: expo's CI mode disables the client attach that log
    // streaming rides on.
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let buffer = '';
const lines = [];
const waiters = [];
function onChunk(chunk) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        lines.push({ at: Date.now(), line });
        for (const w of [...waiters]) {
            if (w.test(line)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(line);
            }
        }
    }
}
metro.stdout.on('data', (d) => onChunk(String(d)));
metro.stderr.on('data', (d) => onChunk(String(d)));
metro.on('exit', (code) => {
    if (!finished) fail(`metro exited early (code ${code})`);
});

function waitForLine(test, timeoutMs, what) {
    return new Promise((resolve, reject) => {
        const existing = lines.find((l) => l.at > scanFrom && test(l.line));
        if (existing) return resolve(existing.line);
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => {
            if (waiters.includes(w)) {
                waiters.splice(waiters.indexOf(w), 1);
                reject(new Error(`timed out waiting for ${what}`));
            }
        }, timeoutMs);
    });
}

let finished = false;
function fail(msg) {
    finished = true;
    console.error(`\nFAIL: ${msg}`);
    console.error('--- last metro output ---');
    for (const l of lines.slice(-30)) console.error(l.line);
    try { metro.kill(); } catch { /* already dead */ }
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let scanFrom = 0;

// ---------------------------------------------------------------- run
try {
    await waitForLine((l) => l.includes('Waiting on http://localhost:8081'), 60_000, 'metro to listen');

    log('relaunching app');
    try { sim('terminate', 'booted', APP_ID); } catch { /* not running */ }
    sim('launch', 'booted', APP_ID);
    // Point the dev client at this Metro rather than whatever it last used.
    // The client ignores a localhost URL; it wants the LAN address, the same
    // one `expo start` prints. A deep link that arrives while the client is
    // still cold-starting is dropped on the floor, so keep knocking until
    // Metro reports a bundle request.
    const lanIp = Object.values(networkInterfaces()).flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lanIp) fail('no LAN IPv4 address found');
    const attachUrl = `${APP_ID}://expo-development-client/?url=${encodeURIComponent(`http://${lanIp}:8081`)}`;
    let attached = false;
    for (let attempt = 0; attempt < 8 && !attached; attempt++) {
        await sleep(attempt === 0 ? 5000 : 10_000);
        sim('openurl', 'booted', attachUrl);
        attached = await waitForLine((l) => l.includes('Bundled') || l.includes(' LOG '), 15_000, 'client attach')
            .then(() => true, () => false);
    }
    if (!attached) fail('dev client never attached to metro');

    // Generous: a cold Metro cache can spend minutes on the first bundle.
    const recentLine = await waitForLine((l) => l.includes('[perf] recent-sessions '), 360_000, 'session list sync');
    const ids = recentLine.split('[perf] recent-sessions ')[1].trim().split(',').filter(Boolean).slice(0, SESSION_COUNT);
    if (ids.length === 0) fail('no sessions reported — is the app logged in?');
    log(`testing ${ids.length} sessions`);

    const results = [];
    for (const id of ids) {
        scanFrom = Date.now();
        sim('openurl', 'booted', `happy://session/${id}`);
        try {
            await waitForLine((l) => l.includes(`[perf] ChatList ${id} commit #1 `), 15_000, `first commit of ${id}`);
        } catch (e) {
            results.push({ id, error: String(e.message), failures: ['no first commit'] });
            log(`${id} FAIL: no first commit within 15s`);
            continue;
        }
        await sleep(BUDGETS.settleMs);

        const window = lines.filter((l) => l.at >= scanFrom);
        const commits = window
            .map((l) => ({ at: l.at, m: l.line.match(new RegExp(`\\[perf\\] ChatList ${id} commit #(\\d+) ([\\d.]+)ms`)) }))
            .filter((c) => c.m)
            .map((c) => ({ n: Number(c.m[1]), ms: Number(c.m[2]), at: c.at }));
        const worst = commits.reduce((a, c) => Math.max(a, c.ms), 0);
        const mounted = window
            .map((l) => l.line.match(new RegExp(`\\[perf\\] ChatList ${id} mounted items=(\\d+) \\+(\\d+)ms`)))
            .filter(Boolean).map((m) => ({ items: Number(m[1]), ms: Number(m[2]) }))[0] ?? null;
        const slowApplies = window
            .map((l) => l.line.match(/\[perf\] applyMessages \S+ (\d+)ms batch=(\d+)/))
            .filter(Boolean).map((m) => Number(m[1]))
            .filter((ms) => ms > BUDGETS.applyMessagesMs);

        // Steady-state quiet: in the final 3s, a session receiving nothing
        // must not keep committing — that is churn, whatever its source.
        // Streaming sessions are exempt: a commit per arriving batch is the
        // list doing its job.
        const quietStart = Date.now() - 3000;
        const activeInQuiet = window.some((l) => l.at >= quietStart
            && (l.line.includes(`applyMessages ${id}`) || l.line.includes(`"sid":"${id}"`)));
        const quietCommits = activeInQuiet ? null : commits.filter((c) => c.at >= quietStart).length;

        const failures = [];
        if (worst > BUDGETS.worstCommitMs) failures.push(`B1 worst commit ${worst}ms > ${BUDGETS.worstCommitMs}ms`);
        if (quietCommits !== null && quietCommits > BUDGETS.quietCommits) failures.push(`B2 ${quietCommits} commits while idle > ${BUDGETS.quietCommits}`);
        if (mounted && mounted.ms > BUDGETS.mountedMs) failures.push(`B3 mounted +${mounted.ms}ms > ${BUDGETS.mountedMs}ms`);
        if (slowApplies.length) failures.push(`B4 applyMessages ${Math.max(...slowApplies)}ms > ${BUDGETS.applyMessagesMs}ms`);

        results.push({
            id,
            worstCommitMs: worst,
            commits: commits.length,
            quietCommits,
            mountedMs: mounted?.ms ?? null,
            mountedItems: mounted?.items ?? null,
            slowApplies,
            failures,
        });
        log(`${id} worst=${worst}ms quiet=${quietCommits ?? 'streaming'} mounted=+${mounted?.ms}ms items=${mounted?.items}${failures.length ? ` FAIL: ${failures.join('; ')}` : ' ok'}`);
    }

    mkdirSync(path.join(appRoot, '.context'), { recursive: true });
    const reportPath = path.join(appRoot, '.context', `perf-report-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify({ budgets: BUDGETS, results }, null, 2));
    log(`report: ${reportPath}`);

    const failed = results.filter((r) => r.error || (r.failures && r.failures.length));
    finished = true;
    metro.kill();
    if (failed.length) {
        console.error(`\nFAIL: ${failed.length}/${results.length} sessions broke budgets`);
        process.exit(1);
    }
    console.log(`\nPASS: ${results.length} sessions within budgets`);
    process.exit(0);
} catch (e) {
    fail(String(e?.message ?? e));
}
