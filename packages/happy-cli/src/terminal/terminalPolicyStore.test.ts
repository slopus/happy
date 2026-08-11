import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalPolicyStore } from './terminalPolicyStore';

const dirs: string[] = [];

function tempPolicyFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'happy-terminal-policy-'));
    dirs.push(dir);
    return join(dir, 'terminal.settings.json');
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('TerminalPolicyStore', () => {
    it('defaults to per-session approval', async () => {
        const store = new TerminalPolicyStore(tempPolicyFile());
        await store.load();
        expect(store.get()).toBe('per-session');
        expect(store.getApprovedOnce()).toBe(false);
    });

    it('persists policy and one-time approval across instances', async () => {
        const file = tempPolicyFile();
        const first = new TerminalPolicyStore(file);
        await first.load();
        await first.set('once-per-machine');
        await first.approveOnce();

        const second = new TerminalPolicyStore(file);
        await second.load();
        expect(second.get()).toBe('once-per-machine');
        expect(second.getApprovedOnce()).toBe(true);
    });

    it('clears one-time approval when switching away from once-per-machine', async () => {
        const file = tempPolicyFile();
        const store = new TerminalPolicyStore(file);
        await store.load();
        await store.set('once-per-machine');
        await store.approveOnce();
        await store.set('per-session');
        expect(store.getApprovedOnce()).toBe(false);
    });

    it('rejects unknown policies', async () => {
        const store = new TerminalPolicyStore(tempPolicyFile());
        await store.load();
        await expect(store.set('sometimes' as never)).rejects.toThrow();
    });

    it('falls back to defaults for a corrupt file', async () => {
        const file = tempPolicyFile();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, '{not-json');
        const store = new TerminalPolicyStore(file);
        await store.load();
        expect(store.get()).toBe('per-session');
    });
});
