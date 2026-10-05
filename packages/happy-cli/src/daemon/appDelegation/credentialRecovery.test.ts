import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccountLaunch } from '@/daemon/codexAccountLaunch';
import { createRuntimeProcessGuard, canRecoverRuntimeProcess } from './runtimeProcessState';
import { recoverAppChatCredentialJobs } from './credentialRecovery';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const auth = { tokens: { id_token: 'fixture-id', access_token: 'fixture-access', refresh_token: 'fixture-refresh', account_id: 'fixture-account' } };
async function fixture() {
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'app-credential-recovery-')); roots.push(recoveryRoot);
    const root = join(recoveryRoot, 'job-test'), home = join(root, 'codex'), cwd = join(root, 'empty');
    await mkdir(cwd, { recursive: true });
    const saved: unknown[] = [];
    const api = {
        redeemCodexSessionGrant: async () => ({ auth, launchId: 'launch', profile: { id: 'profile', displayName: 'Fixture', credentialVersion: 3 } }),
        attachCodexSession: async () => ({ success: true as const }),
        updateCodexAccountCredential: async (id: string, request: unknown) => { saved.push({ id, request }); return { profile: { id: 'profile', displayName: 'Fixture', credentialVersion: 4, status: 'available' as const } }; },
        reportCodexAccountQuota: async () => ({ accepted: true }),
        reportCodexAccountStatus: async () => ({ profile: { id: 'profile', displayName: 'Fixture', credentialVersion: 3, status: 'available' as const } }),
    };
    await CodexAccountLaunch.prepare(api, 'machine', 'g'.repeat(43), { sourceHome: cwd, createTempDir: () => home, skipHistory: true, historyRoot: join(recoveryRoot, 'history') });
    const rotated = { ...auth, tokens: { ...auth.tokens, access_token: 'fixture-rotated' } };
    await writeFile(join(home, 'auth.json'), JSON.stringify(rotated));
    return { recoveryRoot, root, home, api, saved, rotated, guard: createRuntimeProcessGuard(root) };
}
async function deadProcessPid() {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(child, 'close');
    return child.pid!;
}
describe('app credential recovery process proof', () => {
    it('retains credentials after an interrupted first launch with no recorded PID', async () => {
        const f = await fixture();
        await f.guard.beforeSpawn(); // Daemon exits here or after spawn, before it can record the PID.
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(false);
        expect(f.saved).toEqual([]);
        expect(JSON.parse(await readFile(join(f.home, 'auth.json'), 'utf8'))).toEqual(f.rotated);
    });
    it('retains credentials during interrupted discovery-to-turn handoff despite a dead discovery PID', async () => {
        const f = await fixture(), deadPid = await deadProcessPid();
        const discovery = await f.guard.beforeSpawn(); await f.guard.spawned(discovery, deadPid);
        await writeFile(join(f.root, '.runtime-started'), '1');
        await writeFile(join(f.root, '.runtime-pid'), String(deadPid));
        expect(await canRecoverRuntimeProcess(f.root)).toBe(true);
        const turn = await f.guard.beforeSpawn();
        expect(turn).not.toBe(discovery);
        await expect(f.guard.spawned(discovery, deadPid)).rejects.toThrow('runtime-launch-changed');
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(false);
        expect(f.saved).toEqual([]);
        expect(JSON.parse(await readFile(join(f.home, 'auth.json'), 'utf8'))).toEqual(f.rotated);
    });
    it('rejects missing new evidence and never treats legacy dead-PID markers as proof of the latest child', async () => {
        const f = await fixture(), deadPid = await deadProcessPid();
        await writeFile(join(f.root, '.runtime-started'), '1'); await writeFile(join(f.root, '.runtime-pid'), String(deadPid));
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(false);
        expect(f.saved).toEqual([]);
        expect((await stat(f.home)).isDirectory()).toBe(true);
    });
    it('saves same-profile rotated credentials and removes a job only with verifiable new-format child death', async () => {
        const f = await fixture(), generation = await f.guard.beforeSpawn();
        await f.guard.spawned(generation, await deadProcessPid());
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(true);
        expect(f.saved).toMatchObject([{ id: 'profile', request: { machineId: 'machine', launchId: 'launch', expectedVersion: 3, auth: { tokens: { access_token: 'fixture-rotated' } } } }]);
        await expect(stat(f.root)).rejects.toThrow();
    });
    it('does not recover a live child, malformed process evidence or incomplete launch state', async () => {
        const f = await fixture(), generation = await f.guard.beforeSpawn(); await f.guard.spawned(generation, process.pid);
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(false);
        await writeFile(join(f.root, '.runtime-process.json'), '{"phase":"running","pid":0}');
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(false);
        await rm(join(f.home, '.paws-account-launch.json'));
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(false);
        expect((await stat(f.home)).isDirectory()).toBe(true);
        expect(f.saved).toEqual([]);
    });
    it('removes only untouched pre-credential job directories without launch evidence', async () => {
        const f = await fixture();
        await rm(f.root, { recursive: true }); await mkdir(f.root);
        expect(await recoverAppChatCredentialJobs(f.recoveryRoot, 'machine', f.api)).toBe(true);
        await expect(stat(f.root)).rejects.toThrow();
    });
});
