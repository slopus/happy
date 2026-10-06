/** Native process boundaries for explicitly authorized application service tools and speed. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRestrictedCodex, type RestrictedServiceOptions } from './restrictedCodex';
import { runRestrictedClaude } from './restrictedClaude';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function codexFixture(actual: object = {}) {
    const root = await mkdtemp(join(tmpdir(), 'service-runtime-options-')); roots.push(root);
    const binary = join(root, 'codex'), audit = join(root, 'audit.jsonl'), args = join(root, 'args.json');
    await writeFile(binary, `#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');if(process.argv.includes('--version')){console.log('codex-cli 0.159.3');process.exit(0)};
fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify(m)+'\\n');if(m.id==null)return;const result=m.method==='thread/start'?{thread:{id:'thread'},...${JSON.stringify(actual)}}:{};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({method:'item/started',params:{item:{type:'commandExecution'}}}));console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'done'}}));console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));}});`, { mode: 0o700 });
    return { root, binary, audit, args };
}

async function runCodex(f: Awaited<ReturnType<typeof codexFixture>>, options: RestrictedServiceOptions) {
    return runRestrictedCodex(f.binary, join(f.root, 'home'), f.root, [{ role: 'user', text: 'Read a file' }], new AbortController().signal, () => {}, undefined, 'native', undefined, options);
}

describe('authorized Codex service execution', () => {
    it('enables native execution for YOLO and forwards Fast to the process, thread and turn', async () => {
        const f = await codexFixture({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, serviceTier: 'priority' });
        const reported: object[] = [];
        expect(await runCodex(f, { systemPrompt: 'Use tools for this task.', reasoning: { mode: 'default' }, permissionMode: 'yolo', serviceTier: 'fast',
            onPermissionMode: value => reported.push({ permissionMode: value }), onServiceTier: value => reported.push({ serviceTier: value }) })).toBe('done');
        const args: string[] = JSON.parse(await readFile(f.args, 'utf8'));
        expect(args).toContain('features.shell_tool=true');
        expect(args).toContain('features.unified_exec=true');
        expect(args).toContain('features.apply_patch_freeform=true');
        expect(args).toContain('service_tier="fast"');
        const requests = (await readFile(f.audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(requests.find(event => event.method === 'thread/start').params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access', serviceTier: 'priority' });
        expect(requests.find(event => event.method === 'turn/start').params).toMatchObject({ serviceTier: 'priority' });
        expect(reported).toEqual([{ permissionMode: 'yolo' }, { serviceTier: 'priority' }]);
    });
    it('retains the native read-only sandbox while enabling read tools', async () => {
        const f = await codexFixture({ approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } });
        const actual: string[] = [];
        expect(await runCodex(f, { systemPrompt: 'Read only.', reasoning: { mode: 'default' }, permissionMode: 'read-only', onPermissionMode: value => actual.push(value) })).toBe('done');
        const args: string[] = JSON.parse(await readFile(f.args, 'utf8'));
        expect(args).toContain('features.shell_tool=true');
        expect(args).toContain('features.apply_patch_freeform=false');
        const requests = (await readFile(f.audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(requests.find(event => event.method === 'thread/start').params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
        expect(actual).toEqual(['read-only']);
    });
    it('does not substitute requested settings for missing native receipts', async () => {
        const f = await codexFixture(), actual: string[] = [];
        await runCodex(f, { systemPrompt: 'Do the task.', reasoning: { mode: 'default' }, permissionMode: 'yolo', serviceTier: 'fast', onPermissionMode: value => actual.push(value), onServiceTier: value => actual.push(value) });
        expect(actual).toEqual([]);
    });
    it('stops before a turn if the runtime grants more access than read-only requested', async () => {
        const f = await codexFixture({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
        await expect(runCodex(f, { systemPrompt: 'Read only.', reasoning: { mode: 'default' }, permissionMode: 'read-only' })).rejects.toThrow('permission-denied');
        expect(await readFile(f.audit, 'utf8')).not.toContain('turn/start');
    });
});

describe('authorized Claude service execution', () => {
    it('uses native bypass with built-in tools while retaining customization isolation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'service-claude-options-')); roots.push(root);
        const binary = join(root, 'claude'), actual: string[] = [];
        await writeFile(binary, `#!/usr/bin/env node
const fs=require('fs');if(process.argv.includes('--version')){console.log('2.1.251 (Claude Code)');process.exit(0)}fs.writeFileSync(${JSON.stringify(join(root, 'args.json'))},JSON.stringify(process.argv.slice(2)));process.stdin.resume();process.stdin.on('end',()=>{for(const e of [{type:'system',subtype:'init',permissionMode:'bypassPermissions',tools:['Bash','Read'],mcp_servers:[]},{type:'assistant',message:{content:[{type:'tool_use',name:'Read'}]}},{type:'result',subtype:'success',result:'read complete'}])console.log(JSON.stringify(e));});`, { mode: 0o700 });
        expect(await runRestrictedClaude(binary, root, [{ role: 'user', text: 'Read a file' }], new AbortController().signal, () => {}, 'sonnet', undefined, {
            systemPrompt: 'Do the task.', reasoning: { mode: 'default' }, permissionMode: 'yolo', env: { HOME: root, PATH: process.env.PATH }, verifyIdentity: async () => {}, onPermissionMode: value => actual.push(value),
        })).toBe('read complete');
        const args: string[] = JSON.parse(await readFile(join(root, 'args.json'), 'utf8'));
        expect(args).toContain('--safe-mode');
        expect(args[args.indexOf('--tools') + 1]).toBe('default');
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
        expect(actual).toEqual(['yolo']);
    });
});
