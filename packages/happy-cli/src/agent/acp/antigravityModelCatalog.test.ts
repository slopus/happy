import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    readAntigravityModelCatalog,
    createAntigravityModelCatalogReader,
    registerAntigravityModelCatalogHandler,
} from './antigravityModelCatalog';
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(hang = false) {
    const directory = await mkdtemp(join(tmpdir(), 'paws-agy-catalog-'));
    roots.push(directory);
    const log = join(directory, 'calls.jsonl');
    const snapshot = {
        sessionId: 'probe',
        configOptions: [
            {
                id: 'model',
                name: 'Model',
                type: 'select',
                category: 'model',
                currentValue: 'neon',
                options: [
                    { value: 'neon', name: 'Neon' },
                    { value: 'argon', name: 'Argon' },
                ],
            },
            {
                id: 'effort',
                name: 'Effort',
                type: 'select',
                category: 'thought_level',
                currentValue: 'high',
                options: [
                    { value: 'high', name: 'High' },
                    { value: 'xhigh', name: 'Extra' },
                ],
            },
        ],
        models: {
            currentModelId: 'neon-high',
            availableModels: [
                { modelId: 'neon-high', name: 'Neon High' },
                { modelId: 'argon-low', name: 'Argon Low' },
            ],
        },
    };
    const script = String.raw`const fs=require('node:fs'); require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({...m,pid:process.pid})+'\n');if(m.id===undefined)return;if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\n');else if(m.method==='session/new'&&!${hang})process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${JSON.stringify(snapshot)}})+'\n');else if(m.method!=='session/new')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\n');});`;
    return { directory, log, command: process.execPath, args: ['-e', script] };
}
it('reads actual categorized models and observed efforts through ACP without a prompt or model changes', async () => {
    const f = await fixture();
    const result = await readAntigravityModelCatalog(f);
    expect(result).toMatchObject({
        source: 'antigravity-native',
        currentModelCode: 'neon',
        currentThoughtLevelCode: 'high',
        models: [
            { code: 'neon', value: 'Neon', supportedEffortLevels: ['high', 'xhigh'] },
            { code: 'argon', value: 'Argon', supportedEffortLevels: ['low'] },
        ],
    });
    const calls = (await readFile(f.log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.id !== undefined).map((call) => call.method)).toEqual([
        'initialize',
        'session/new',
    ]);
    expect(calls.find((call) => call.method === 'session/new').params).toEqual({ cwd: f.directory, mcpServers: [] });
});
it('fails once at the deadline and closes a hung handshake instead of retrying in the background', async () => {
    const f = await fixture(true);
    await expect(readAntigravityModelCatalog({ ...f, timeoutMs: 1000 })).rejects.toThrow(/timed out|timeout/i);
    const calls = (await readFile(f.log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'session/new')).toHaveLength(1);
    expect(Number.isSafeInteger(calls[0].pid)).toBe(true);
    let alive = false;
    try {
        process.kill(calls[0].pid, 0);
        alive = true;
    } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(alive).toBe(false);
});
it('coalesces same-directory in-flight work, caps parallel probes, and permits a fresh user action', async () => {
    let resolve!: (value: any) => void;
    const first = new Promise<any>((r) => {
        resolve = r;
    });
    const read = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ models: [] });
    const reader = createAntigravityModelCatalogReader(read);
    const a = reader('/a');
    expect(reader('/a')).toBe(a);
    await expect(reader('/b')).rejects.toThrow(/busy/i);
    resolve({ models: [] });
    await a;
    await reader('/a');
    expect(read).toHaveBeenCalledTimes(2);
});
it('rejects arbitrary spawn options and non-absolute directories before launching a probe', async () => {
    let handler!: (raw: unknown) => Promise<unknown>;
    const read = vi.fn();
    registerAntigravityModelCatalogHandler(
        {
            registerHandler: (_name: string, h: any) => {
                handler = h;
            },
        } as any,
        read,
    );
    await expect(handler({ directory: '/tmp', command: 'other' })).rejects.toThrow();
    await expect(handler({ directory: 'relative' })).rejects.toThrow(/absolute/);
    expect(read).not.toHaveBeenCalled();
});
