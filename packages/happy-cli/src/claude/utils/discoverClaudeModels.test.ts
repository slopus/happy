import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeModels } from './discoverClaudeModels';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** A real SDK control-protocol peer: no inference or credentials are involved. */
function runtime(respond: boolean) {
    const cwd = mkdtempSync(join(tmpdir(), 'happy-model-catalog-'));
    directories.push(cwd);
    const executable = join(cwd, 'claude-fixture.js');
    writeFileSync(executable, `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
    const message = JSON.parse(line);
    fs.appendFileSync(path.join(__dirname, 'received.jsonl'), line + '\\n');
    if (${respond} && message.type === 'control_request') {
        process.stdout.write(JSON.stringify({ type: 'control_response', response: {
            subtype: 'success', request_id: message.request_id,
            response: { commands: [], agents: [], output_style: 'default', available_output_styles: [],
                models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5' }] },
        } }) + '\\n');
    }
});
input.on('close', () => process.exit(0));
`);
    return { cwd, executable };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Runtime fixture did not reach expected state');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function exited(pid: number): boolean {
    try { process.kill(pid, 0); return false; } catch { return true; }
}

describe('discoverClaudeModels lifecycle', () => {
    it('returns the runtime catalog without submitting a user turn and closes the child', async () => {
        const { cwd, executable } = runtime(true);
        const models = await discoverClaudeModels({ cwd, env: { HAPPY_CLAUDE_PATH: executable }, signal: new AbortController().signal, useLocalCli: true });
        expect(models).toEqual([{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5' }]);
        const messages = readFileSync(join(cwd, 'received.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(messages.some(message => message.type === 'control_request')).toBe(true);
        expect(messages.some(message => message.type === 'user')).toBe(false);
        await waitUntil(() => exited(Number(readFileSync(join(cwd, 'pid'), 'utf8'))));
    });

    it('does not launch a process when already cancelled', async () => {
        const { cwd, executable } = runtime(true);
        const controller = new AbortController();
        controller.abort();
        expect(await discoverClaudeModels({ cwd, env: { HAPPY_CLAUDE_PATH: executable }, signal: controller.signal, useLocalCli: true })).toEqual([]);
        expect(existsSync(join(cwd, 'pid'))).toBe(false);
    });

    it('cancels unresponsive initialization and releases the child process', async () => {
        const { cwd, executable } = runtime(false);
        const controller = new AbortController();
        const pending = discoverClaudeModels({ cwd, env: { HAPPY_CLAUDE_PATH: executable }, signal: controller.signal, useLocalCli: true });
        await waitUntil(() => existsSync(join(cwd, 'pid')));
        controller.abort();
        expect(await pending).toEqual([]);
        await waitUntil(() => exited(Number(readFileSync(join(cwd, 'pid'), 'utf8'))));
    });
});
