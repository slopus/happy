import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { prepareCodexRecallHost, buildCodexMemoryReferenceBlock, readRecallDiagnostic } from './codexRecallHost';
import { withCodexRecallOwnership } from './recallOwnerMarker';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(workerBody?: string) {
    const root = mkdtempSync(join(tmpdir(), 'happy-recall-host-'));
    fixtures.push(root);
    mkdirSync(join(root, 'services'));
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'services', 'recall-host-contract.js'), '');
    const script = `let data=''; process.stdin.on('data', chunk=> data += chunk); process.stdin.on('end', ()=> {
        const input = JSON.parse(data);
        ${workerBody ?? `const context=JSON.stringify({input,owner:process.env.CLAUDE_MEMORY_RECALL_OWNER,cwd:process.cwd()});
        process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:'complete',outcome:'selected'})+'\\n');
        process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:context}}));`}
    });`;
    writeFileSync(join(root, 'hooks', 'codex-session-start.js'), script);
    writeFileSync(join(root, 'hooks', 'codex-user-prompt-submit.js'), script);
    return {
        root,
        options: {
            accountOwned: true, sandboxEnabled: true, sandboxPolicyMode: 'owner-choice' as const, projectPath: root, env: { CLAUDE_MEMORY_RECALL_OWNER: 'host', CLAUDE_MEMORY_DEBUG: '1' },
            deps: {
                resolveEntry: vi.fn(async () => join(root, 'services', 'lesson-host-service.js')),
                runtimeCompatible: vi.fn(async () => true),
                load: vi.fn(async () => ({ CML_RECALL_HOST_CAPABILITIES: { version: 1, nativeEventOwnerMarker: true } })),
            },
        },
    };
}
const turn = (extra = {}) => ({ threadId: 'native-thread', prompt: 'original request', resumed: false, signal: new AbortController().signal, ...extra });

describe('Codex event-memory host', () => {
    it('does not open a project memory host without an authenticated project path', async () => {
        const { options } = fixture();
        expect(await prepareCodexRecallHost({ ...options, projectPath: null })).toBeNull();
        expect(options.deps.resolveEntry).not.toHaveBeenCalled();
    });

    it('gates account, sandbox, capability and artifacts without disabling legacy hooks', async () => {
        const { options, root } = fixture();
        for (const changes of [{ accountOwned: false }, { sandboxEnabled: false }, { sandboxPolicyMode: 'mandatory' as const }]) {
            expect(await prepareCodexRecallHost({ ...options, ...changes })).toBeNull();
        }
        expect(options.deps.resolveEntry).not.toHaveBeenCalled();
        for (const capability of [undefined, { version: 2, nativeEventOwnerMarker: true }, { version: 1, nativeEventOwnerMarker: false }]) {
            expect(await prepareCodexRecallHost({ ...options, deps: { ...options.deps, load: async () => ({ CML_RECALL_HOST_CAPABILITIES: capability }) } })).toBeNull();
        }
        rmSync(join(root, 'hooks', 'codex-session-start.js'));
        expect(await prepareCodexRecallHost(options)).toBeNull();
        expect(await prepareCodexRecallHost({ ...options, deps: { resolveEntry: async () => null } })).toBeNull();
        expect(await prepareCodexRecallHost({ ...options, deps: { resolveEntry: async () => { throw new Error('private path'); } } })).toBeNull();
    });

    it('keeps native recall enabled when the host Node cannot load CML native SQLite', async () => {
        const { options } = fixture();
        expect(await prepareCodexRecallHost({ ...options, deps: { ...options.deps, runtimeCompatible: async () => false } })).toBeNull();
    });

    it('runs trusted host node with original project scope and unwrapped prompt, warms once per native thread', async () => {
        const { options, root } = fixture();
        const spawnSpy = vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => spawn(command, args, options));
        const report = vi.fn();
        const host = await prepareCodexRecallHost({ ...options, report, deps: { ...options.deps, spawn: spawnSpy } });
        expect(host).not.toBeNull();
        options.env.CLAUDE_MEMORY_RECALL_OWNER = 'changed-later';
        options.projectPath = '/renderer-controlled-path';
        const first = await host!.recall(turn({ resumed: true }));
        expect(first.reason).toBe('context_returned');
        const [warm, query] = first.context.split('\n\n').map(line => JSON.parse(line));
        expect(warm.input).toEqual({ session_id: 'native-thread', cwd: root, hook_event_name: 'SessionStart', source: 'resume' });
        expect(query.input).toEqual({ session_id: 'native-thread', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'original request' });
        expect(query.owner).toBe('host-worker');
        expect(query.cwd).toBe(realpathSync(root));
        expect(spawnSpy.mock.calls[0][2].env?.CLAUDE_MEMORY_DEBUG).toBeUndefined();
        expect(spawnSpy.mock.calls[0][0]).toBe(process.execPath);
        await host!.recall(turn());
        expect(spawnSpy).toHaveBeenCalledTimes(3);
        await host!.recall(turn({ threadId: 'new-native-thread' }));
        expect(spawnSpy).toHaveBeenCalledTimes(5);
        expect(report.mock.calls.every(([record]) => Object.keys(record).sort().join(',') === 'contextChars,event,reason')).toBe(true);
    });

    it('accepts intentional empty only with valid envelope and terminal diagnostics', async () => {
        const { options } = fixture(`process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:'complete',outcome:'skipped'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name}}));`);
        const host = await prepareCodexRecallHost(options);
        expect(await host!.recall(turn())).toEqual({ reason: 'empty', context: '' });
    });

    it('retains startup context across unsubmitted turns and stops repeating it after submission', async () => {
        const { options } = fixture(`const warm = input.hook_event_name === 'SessionStart';
            process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:'complete',outcome:warm?'selected':'empty'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,...(warm?{additionalContext:'startup reference'}:{})}}));`);
        const host = await prepareCodexRecallHost(options);
        expect(await host!.recall(turn())).toEqual({ reason: 'context_returned', context: 'startup reference', startupIncluded: true });
        expect(await host!.recall(turn())).toEqual({ reason: 'context_returned', context: 'startup reference', startupIncluded: true });
        host!.markSubmitted('another-thread', true);
        expect(await host!.recall(turn())).toEqual({ reason: 'context_returned', context: 'startup reference', startupIncluded: true });
        host!.markSubmitted('native-thread', true);
        expect(await host!.recall(turn())).toEqual({ reason: 'empty', context: '' });
    });

    it('does not hide failed startup behind an empty prompt query', async () => {
        const { options } = fixture(`const warm = input.hook_event_name === 'SessionStart';
            process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:warm?'service':'complete',outcome:warm?'error':'empty'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name}}));`);
        const host = await prepareCodexRecallHost(options);
        expect(await host!.recall(turn())).toEqual({ reason: 'hook_diagnostic', context: '' });
    });

    it('prioritizes valid prompt context on combined overflow and preserves pending startup', async () => {
        const { options } = fixture(`const warm = input.hook_event_name === 'SessionStart';
            const context=warm?'startup '+ 's'.repeat(15000): input.prompt==='empty'?'':'prompt '+ 'p'.repeat(15000);
            process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:'complete',outcome:context?'selected':'empty'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,...(context?{additionalContext:context}:{})}}));`);
        const host = await prepareCodexRecallHost(options);
        const first = await host!.recall(turn());
        expect(first.reason).toBe('context_returned');
        expect(first.context).toMatch(/^prompt /);
        expect(first.startupIncluded).toBeUndefined();
        host!.markSubmitted('native-thread', first.startupIncluded === true);
        const next = await host!.recall(turn({ prompt: 'empty' }));
        expect(next.reason).toBe('context_returned');
        expect(next.context).toMatch(/^startup /);
        expect(next.startupIncluded).toBe(true);
        host!.markSubmitted('native-thread', true);
        expect(await host!.recall(turn({ prompt: 'empty' }))).toEqual({ reason: 'empty', context: '' });
    });

    it('backs off persistent startup failures while retaining failure reason and resetting on new threads', async () => {
        const { options } = fixture(`const warm = input.hook_event_name === 'SessionStart';
            process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:warm?'service':'complete',outcome:warm?'error':'empty'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name}}));`);
        const report = vi.fn();
        let time=0;
        const host=await prepareCodexRecallHost({...options,report,now:()=>time});
        expect(await host!.recall(turn())).toEqual({reason:'hook_diagnostic',context:''});
        expect(await host!.recall(turn())).toEqual({reason:'hook_diagnostic',context:''});
        expect(report.mock.calls.filter(([r])=>r.event==='SessionStart')).toHaveLength(1);
        time=30001;
        await host!.recall(turn());
        expect(report.mock.calls.filter(([r])=>r.event==='SessionStart')).toHaveLength(2);
        await host!.recall(turn({threadId:'new-thread'}));
        expect(report.mock.calls.filter(([r])=>r.event==='SessionStart')).toHaveLength(3);
    });

    it.each([
        ["process.stdout.write('{}');", 'invalid_output'],
        ["process.stdout.write('not-json');", 'invalid_output'],
        ["process.exit(2);", 'hook_failed'],
        ["process.stdout.write('a'.repeat(262145));", 'output_limit'],
        ["process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'wrong',additionalContext:''}}));", 'invalid_output'],
        [`process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:'service',outcome:'error',errorCode:'EPERM'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name}}));`, 'hook_diagnostic'],
        [`process.stderr.write('[cml-recall] '+JSON.stringify({version:1,event:input.hook_event_name,stage:'complete',outcome:'selected'})+'\\n');
            process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:'a'.repeat(24001)}}));`, 'output_limit'],
    ])('classifies failure without exposing stderr or reporting healthy empty', async (body, reason) => {
        const { options } = fixture(body);
        const host = await prepareCodexRecallHost(options);
        expect(await host!.recall(turn())).toEqual({ reason, context: '' });
    });

    it('bounds hung workers and never calls timeout healthy empty', async () => {
        const { options } = fixture('setInterval(()=>{},1000);');
        const host = await prepareCodexRecallHost({ ...options, budgetMs: 50 });
        expect(await host!.recall(turn())).toEqual({ reason: 'timeout', context: '' });
    });

    it('leaves native ownership intact when the capability lookup stalls', async () => {
        const { options } = fixture();
        expect(await prepareCodexRecallHost({ ...options, prepareBudgetMs: 25, deps: { ...options.deps, load: () => new Promise(() => {}) } })).toBeNull();
    });

    it('kills an aborted worker and does not query after cancelled warm-up', async () => {
        const { options } = fixture('setInterval(()=>{},1000);');
        const report = vi.fn();
        const host = await prepareCodexRecallHost({ ...options, report });
        const controller = new AbortController();
        const pending = host!.recall(turn({ signal: controller.signal }));
        controller.abort();
        expect(await pending).toEqual({ reason: 'cancelled', context: '' });
        expect(report).toHaveBeenCalledTimes(1);
        expect(await host!.recall(turn({ signal: controller.signal }))).toEqual({ reason: 'cancelled', context: '' });
    });

    it('handles synchronous host spawn failure without blocking the foreground turn', async () => {
        const { options } = fixture();
        const host = await prepareCodexRecallHost({ ...options, deps: { ...options.deps, spawn: () => { throw new Error('private prompt/path'); } } });
        expect(await host!.recall(turn())).toEqual({ reason: 'spawn_failed', context: '' });
    });

    it('distinguishes registry warnings from terminal hook errors and ignores unrelated stderr', () => {
        const record = (stage: string, outcome: string) => '[cml-recall] '+JSON.stringify({version:1,event:'SessionStart',stage,outcome})+'\n';
        expect(readRecallDiagnostic('private error\n'+record('registry','error')+record('complete','empty'), 'SessionStart')).toBe('empty');
        expect(readRecallDiagnostic(record('complete','selected')+record('runtime','error'), 'SessionStart')).toBe('error');
        expect(readRecallDiagnostic(record('service','error')+record('complete','empty'), 'SessionStart')).toBe('error');
        expect(readRecallDiagnostic(record('complete','selected'), 'UserPromptSubmit')).toBeNull();
        expect(readRecallDiagnostic('[cml-recall] invalid', 'SessionStart')).toBeNull();
    });

    it('sets ownership independently from lessons without mutating inherited environment', () => {
        const env = { CLAUDE_MEMORY_RECALL_OWNER: 'host', CLAUDE_MEMORY_LESSON_OWNER: 'host' };
        expect(withCodexRecallOwnership(env, false)).toEqual({ CLAUDE_MEMORY_LESSON_OWNER: 'host' });
        expect(withCodexRecallOwnership(env, true)).toEqual(env);
        expect(env.CLAUDE_MEMORY_RECALL_OWNER).toBe('host');
        expect(buildCodexMemoryReferenceBlock('')).toBe('');
        expect(buildCodexMemoryReferenceBlock('a'.repeat(24_001))).toBe('');
        expect(buildCodexMemoryReferenceBlock('memory text')).toContain('historical evidence');
    });
});
