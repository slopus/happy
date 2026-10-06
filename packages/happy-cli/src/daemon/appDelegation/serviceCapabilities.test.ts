import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexCapabilities, readClaudeCapabilities, claudeIdentityId, validateBoundCapabilities } from './serviceCapabilities';
import type { ExecutionBinding, ServiceTarget } from '@slopus/happy-wire';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const codex: ServiceTarget = { machineId: 'machine', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'profile' } };
const login = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'test@example.com', orgId: 'org', accountUuid: 'account' };
async function executable(code: string) {
    const root = await mkdtemp(join(tmpdir(), 'service-capabilities-')); roots.push(root);
    const binary = join(root, 'runtime');
    await writeFile(binary, '#!/usr/bin/env node\n' + code, { mode: 0o700 });
    return { root, binary };
}
describe('live service capabilities', () => {
    it('advertises Fast only from native priority service-tier evidence', async () => {
        const f = await executable(`const rl=require('readline');if(process.argv.includes('--version')){console.log('codex-cli 0.159.3');process.exit(0)}rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;console.log(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{model:'fast-native',displayName:'Fast native',isDefault:true,serviceTiers:[{id:'priority',name:'Fast'}],supportedReasoningEfforts:[],defaultReasoningEffort:null},{model:'unknown-native',displayName:'Unknown',isDefault:false,supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null}:{}}))});`);
        const catalog = await readCodexCapabilities(codex, f.binary, join(f.root, 'private'), f.root, new AbortController().signal);
        expect(catalog.execution).toEqual({ permissionModes: ['chat-only', 'read-only', 'yolo'], serviceTiers: ['default', 'fast'] });
        expect(catalog.models.map(model => model.serviceTiers)).toEqual([['default', 'fast'], ['default']]);
        const binding: ExecutionBinding = { ...codex, id: 'binding', appId: 'app', serviceId: 'svc', revision: 1, requestedModel: 'fast-native', reasoning: { mode: 'default' }, permissions: ['chat', 'tools'], permissionMode: 'yolo', serviceTier: 'fast' };
        expect(() => validateBoundCapabilities(binding, catalog, false)).not.toThrow();
        expect(() => validateBoundCapabilities({ ...binding, requestedModel: 'unknown-native' }, catalog, false)).toThrow('parameter-unsupported');
        expect(() => validateBoundCapabilities({ ...binding, permissions: ['chat'] }, catalog, false)).toThrow('permission-denied');
        expect(() => validateBoundCapabilities(binding, { ...catalog, execution: undefined }, false)).toThrow('parameter-unsupported');
    });
    it('exposes Claude YOLO only when the verified CLI reports its native permission option', async () => {
        const f = await executable(`if(process.argv.includes('--version'))console.log('2.1.251 (Claude Code)');else if(process.argv.includes('status'))console.log(${JSON.stringify(JSON.stringify(login))});else if(process.argv.includes('--help'))console.log('--model <model> aliases \\'sonnet\\'\\n  --permission-mode <mode> (choices: "dontAsk", "bypassPermissions")\\n  --tools <tools...>\\n  --safe-mode');`);
        const target: ServiceTarget = { engine: 'claude', machineId: 'machine', accountRef: { kind: 'device-identity', machineId: 'machine', identityId: claudeIdentityId(login) } };
        const catalog = await readClaudeCapabilities(target, f.binary, { PATH: process.env.PATH, HOME: f.root }, f.root, new AbortController().signal);
        expect(catalog.execution).toEqual({ permissionModes: ['chat-only', 'yolo'], serviceTiers: ['default'] });
        const binding: ExecutionBinding = { ...target, id: 'binding', appId: 'app', serviceId: 'svc', revision: 1, requestedModel: 'sonnet', reasoning: { mode: 'default' }, permissions: ['chat', 'tools'], permissionMode: 'read-only' };
        expect(() => validateBoundCapabilities(binding, catalog, false)).toThrow('parameter-unsupported');
        expect(() => validateBoundCapabilities({ ...binding, permissionMode: 'yolo', serviceTier: 'fast' }, catalog, false)).toThrow('parameter-unsupported');
    });
    it('reads paginated native models in the exact private Codex home without starting a turn', async () => {
        const f = await executable(`const fs=require('fs'),rl=require('readline');if(process.argv.includes('--version')){console.log('codex-cli 0.159.3');process.exit(0)};fs.writeFileSync(process.cwd()+'/env.json',JSON.stringify({home:process.env.CODEX_HOME,openai:process.env.OPENAI_API_KEY}));rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};if(m.method==='model/list'){result=m.params.cursor?{data:[{id:'second',model:'second',displayName:'Second',isDefault:false,inputModalities:['text'],supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null}:{data:[{id:'native',model:'native',displayName:'Native',isDefault:true,inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'high',description:'High'}],defaultReasoningEffort:'high'}],nextCursor:'page2'}}else if(m.method!=='initialize'){process.exit(9)}console.log(JSON.stringify({id:m.id,result}))});`);
        const catalog = await readCodexCapabilities(codex, f.binary, join(f.root, 'private'), f.root, new AbortController().signal);
        expect(catalog).toMatchObject({ availability: 'online', completeness: 'complete', defaultModelId: 'native', models: [{ id: 'native', supportsImages: true, reasoning: { values: ['high'], defaultValue: 'high' } }, { id: 'second', supportsImages: false }] });
        expect(JSON.parse(await readFile(join(f.root, 'env.json'), 'utf8'))).toEqual({ home: join(f.root, 'private') });
    });
    it('verifies Claude login identity and returns only observed aliases with default reasoning', async () => {
        const f = await executable(`if(process.argv.includes('--version'))console.log('2.1.251 (Claude Code)');else if(process.argv.includes('status'))console.log(${JSON.stringify(JSON.stringify(login))});else if(process.argv.includes('--help'))console.log("--model <model> alias (e.g. 'opus', or 'sonnet') --tools --safe-mode --strict-mcp-config --input-format stream-json");else process.exit(9);`);
        const target: ServiceTarget = { engine: 'claude', machineId: 'machine', accountRef: { kind: 'device-identity', machineId: 'machine', identityId: claudeIdentityId(login) } };
        const catalog = await readClaudeCapabilities(target, f.binary, { PATH: process.env.PATH, HOME: f.root }, f.root, new AbortController().signal);
        expect(catalog).toMatchObject({ completeness: 'limited', defaultModelId: null, models: [{ id: 'opus', supportsImages: false, reasoning: { values: [], supportsDefault: true } }, { id: 'sonnet' }] });
        await expect(readClaudeCapabilities({ ...target, accountRef: { ...target.accountRef, identityId: 'old-account' } }, f.binary, { PATH: process.env.PATH, HOME: f.root }, f.root, new AbortController().signal)).rejects.toThrow('account-identity-changed');
    });
    it('does not invent identity for missing login or API-key status without identity evidence', () => {
        expect(() => claudeIdentityId({ loggedIn: false })).toThrow('account-login-required');
        expect(() => claudeIdentityId({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' })).toThrow('account-login-required');
        expect(claudeIdentityId({ ...login, projectsDirectory: '/changed', expiresAt: 1 })).toBe(claudeIdentityId(login));
        expect(claudeIdentityId({ ...login, accountUuid: 'other' })).not.toBe(claudeIdentityId(login));
        expect(claudeIdentityId({ ...login, authMethod: 'oauth' })).toBe(claudeIdentityId(login));
    });
    it('does not treat aliases outside the model help section as model evidence', async () => {
        const f = await executable(`if(process.argv.includes('--version'))console.log('2.1.251 (Claude Code)');else if(process.argv.includes('status'))console.log(${JSON.stringify(JSON.stringify(login))});else if(process.argv.includes('--help'))console.log("--model <model> alias 'sonnet'\\n  --agent <agent> example 'opus'");`);
        const target: ServiceTarget = { engine: 'claude', machineId: 'machine', accountRef: { kind: 'device-identity', machineId: 'machine', identityId: claudeIdentityId(login) } };
        const catalog = await readClaudeCapabilities(target, f.binary, { PATH: process.env.PATH, HOME: f.root }, f.root, new AbortController().signal);
        expect(catalog.models.map(model => model.id)).toEqual(['sonnet']);
        const bound: ExecutionBinding = { ...target, id: 'binding', appId: 'relationship-advisor', serviceId: 'svc', revision: 1, requestedModel: 'sonnet', reasoning: { mode: 'default' }, permissions: ['chat', 'images'] };
        expect(() => validateBoundCapabilities(bound, catalog, true)).toThrow('parameter-unsupported');
        expect(() => validateBoundCapabilities({ ...bound, permissions: ['chat'], reasoning: { mode: 'explicit', value: 'high' } }, catalog, false)).toThrow('parameter-unsupported');
    });
    it('rejects offline, stale, foreign-account, unsupported reasoning and unknown image evidence', () => {
        const binding: ExecutionBinding = { ...codex, id: 'binding', appId: 'relationship-advisor', serviceId: 'svc', revision: 1, requestedModel: 'native', reasoning: { mode: 'explicit', value: 'high' }, permissions: ['chat'] };
        const catalog = { ...codex, protocol: 'ai-services/1' as const, observedAt: Date.now(), availability: 'online' as const, completeness: 'complete' as const, defaultModelId: 'native', models: [{ id: 'native', name: 'Native', supportsImages: false, reasoning: { supportsDefault: true, values: ['high'], defaultValue: 'high' } }] };
        expect(() => validateBoundCapabilities(binding, catalog, false)).not.toThrow();
        expect(() => validateBoundCapabilities(binding, { ...catalog, availability: 'offline' }, false)).toThrow('machine-offline');
        expect(() => validateBoundCapabilities(binding, { ...catalog, observedAt: Date.now() - 61000 }, false)).toThrow('machine-offline');
        expect(() => validateBoundCapabilities(binding, { ...catalog, accountRef: { kind: 'codex-profile', id: 'other' } }, false)).toThrow('account-identity-changed');
        expect(() => validateBoundCapabilities({ ...binding, reasoning: { mode: 'explicit', value: 'max' } }, catalog, false)).toThrow('parameter-unsupported');
        expect(() => validateBoundCapabilities(binding, catalog, true)).toThrow('permission-denied');
        expect(() => validateBoundCapabilities({ ...binding, permissions: ['chat', 'images'] }, catalog, true)).toThrow('parameter-unsupported');
    });
});
