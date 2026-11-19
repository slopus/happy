import { describe, expect, it, vi } from 'vitest';
import { createClaudeModelCatalogReader, isClaudeEffortSupported, markClaudeModelConnection, normalizeClaudeModels, readClaudeModelCatalog } from './modelCatalog';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('./installedClaude', () => ({ installedClaudeExecutable: () => process.env.HAPPY_CLAUDE_PATH || '/fixture/claude' }));

describe('Claude native model catalogs', () => {
    it('removes the prior child catalog only when replacement initialization confirms an unverified context', () => {
        const prior: any = { path: '/work', host: 'machine', models: [{ code: 'private/old', value: 'Old account' }], modelsUpdatedAt: 1, thoughtLevels: [{ code: 'max', value: 'max' }] };
        expect(markClaudeModelConnection(prior, false, undefined).models).toEqual(prior.models);
        const replacement = markClaudeModelConnection(prior, true, undefined);
        expect(replacement.models).toBeUndefined(); expect(replacement.thoughtLevels).toBeUndefined();
        expect(replacement.capabilities?.claudeModelCatalogRefresh).toBe(false);
        expect(markClaudeModelConnection(prior, true, 'verified').models).toEqual(prior.models);
    });
    it('accepts new effort levels only from the selected model catalog and respects an empty range', () => {
        const models = [{ code: 'future', value: 'Future', supportedEffortLevels: ['future-effort'] }, { code: 'none', value: 'None', supportedEffortLevels: [] }];
        expect(isClaudeEffortSupported('future-effort', 'future', models)).toBe(true);
        expect(isClaudeEffortSupported('high', 'future', models)).toBe(false);
        expect(isClaudeEffortSupported('high', 'none', models)).toBe(false);
        expect(isClaudeEffortSupported('high', 'legacy')).toBe(true);
        expect(isClaudeEffortSupported('future-effort', 'legacy')).toBe(false);
    });
    it('uses native names and efforts without conflating aliases with the same resolved model', () => {
        const models = normalizeClaudeModels([
            { value: 'opus', displayName: 'Opus future', resolvedModel: 'vendor/future', supportedEffortLevels: ['high', 'future-effort'] },
            { value: 'sonnet', displayName: 'Opus future', resolvedModel: 'vendor/future', supportsEffort: false },
            { value: 'vendor/future', displayName: 'Vendor future', description: 'private@example.com', supportedEffortLevels: ['high', 'high'] },
        ]);
        expect(models).toEqual([
            { code: 'opus', value: 'Opus future · opus', supportedEffortLevels: ['high', 'future-effort'] },
            { code: 'sonnet', value: 'Opus future · sonnet', supportedEffortLevels: [] },
            { code: 'vendor/future', value: 'Vendor future', supportedEffortLevels: ['high'] },
        ]);
    });

    it('rejects empty, duplicate and malformed catalogs rather than inventing models', () => {
        for (const models of [[], [{ value: 'x', displayName: '' }], [{ value: 'x', displayName: 'X' }, { value: 'x', displayName: 'X' }]]) {
            expect(() => normalizeClaudeModels(models)).toThrow();
        }
    });

    it('coalesces in-flight queries but fetches again after a model configuration change', async () => {
        let finish!: (result: any) => void;
        const query = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const read = createClaudeModelCatalogReader(query as any);
        const a = read('/one'); const b = read('/one');
        expect(query).toHaveBeenCalledTimes(1);
        finish({ models: [{ code: 'new', value: 'New' }], observedAt: 1 });
        expect(await a).toEqual(await b);
        const c = read('/one');
        expect(query).toHaveBeenCalledTimes(2);
        finish({ models: [{ code: 'newer', value: 'Newer' }], observedAt: 2 });
        expect((await c).models[0].code).toBe('newer');
    });

    it('sends no prompt and always closes a native control probe', async () => {
        const close = vi.fn(); let options: any; let prompt: any;
        const snapshot = await readClaudeModelCatalog({ directory: '/work', env: { HAPPY_CLAUDE_PROXY_URL: 'http://localhost:1234' } }, (args: any) => {
            ({ options, prompt } = args);
            return { initializationResult: async () => ({ models: [{ value: 'opus', displayName: 'Live Opus' }] }), close } as any;
        });
        expect(snapshot.models[0]).toMatchObject({ code: 'opus', value: 'Live Opus' });
        expect(options).toMatchObject({ cwd: '/work', persistSession: false, strictMcpConfig: true, tools: [], settings: { disableAllHooks: true }, env: { HTTPS_PROXY: 'http://localhost:1234' } });
        expect(await prompt[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
        expect(close).toHaveBeenCalledOnce();
    });

    it('bounds initialization and closes a stalled child without retrying', async () => {
        const close = vi.fn(); const query = vi.fn(() => ({ initializationResult: () => new Promise(() => {}), close }) as any);
        await expect(readClaudeModelCatalog({ directory: '/work', timeoutMs: 100 }, query)).rejects.toThrow('timed out');
        expect(query).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    });

    it('uses the installed CLI through the real SDK control protocol without sending user input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'paws-native-models-'));
        const originalPath = process.env.PATH;
        const originalOverride = process.env.HAPPY_CLAUDE_PATH;
        try {
            const record = join(directory, 'protocol.jsonl');
            const executable = join(directory, 'claude');
            await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({type:m.type,subtype:m.request?.subtype})+'\\n');
if(m.type==='user'){process.exit(9);}
if(m.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:m.request.subtype==='get_settings'?{effective:{env:{ANTHROPIC_BASE_URL:'http://fixture',ANTHROPIC_AUTH_TOKEN:'fixture-key'}}}:{commands:[],models:[{value:'vendor/new',displayName:'Native future',supportedEffortLevels:['high']}],account:{}}}}));});
rl.on('close',()=>process.exit(0));
`);
            await chmod(executable, 0o700);
            process.env.PATH = `${directory}:${originalPath}`;
            process.env.HAPPY_CLAUDE_PATH = executable;
            const result = await readClaudeModelCatalog({ directory });
            expect(result.models).toEqual([{ code: 'vendor/new', value: 'Native future', supportedEffortLevels: ['high'] }]);
            expect((await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
                .toEqual([{ type: 'control_request', subtype: 'initialize' }, { type: 'control_request', subtype: 'get_settings' }]);
            expect(result.connectionKey).toMatch(/^[a-f0-9]{64}$/);
        } finally {
            process.env.PATH = originalPath;
            if (originalOverride === undefined) delete process.env.HAPPY_CLAUDE_PATH;
            else process.env.HAPPY_CLAUDE_PATH = originalOverride;
            await rm(directory, { recursive: true, force: true });
        }
    }, 15_000);
});
