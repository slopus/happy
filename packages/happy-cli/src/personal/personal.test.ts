/** Behavioral checks with a real HTTP model endpoint, real files and real command execution. */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { PersonalEngine, type PersonalEvent } from './engine';
import { importGrokSkills, listPersonalSkills } from './skills';
import { PersonalStore } from './store';
import { PersonalTools, personalPermissionMode } from './tools';
import type { ChatMessage } from './model';

const temporary: string[] = [];
const servers: Server[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'paws-personal-test-')); temporary.push(dir); return dir; };
const signal = () => new AbortController().signal;
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});

async function modelEndpoint(reply: (messages: ChatMessage[], request: number) => unknown) {
    let requests = 0;
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        try {
            expect(req.url).toBe('/v1/chat/completions');
            const body = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: reply(body.messages, ++requests), finish_reason: 'stop' }] }));
        } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture', maxSteps: 8, apiKey: undefined };
}

describe('Paws Personal independent engine', () => {
    it('uses a real tool result in the next model request and preserves memory across engine instances', async () => {
        const home = temp(), cwd = temp();
        writeFileSync(join(cwd, 'input.txt'), 'REAL_LOCAL_VALUE');
        const config = await modelEndpoint((messages, request) => {
            if (request === 1) return { role: 'assistant', content: null, tool_calls: [
                { id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"input.txt"}' } },
            ] };
            if (request === 2) {
                expect(messages.at(-1)?.content).toBe('"REAL_LOCAL_VALUE"');
                return { role: 'assistant', content: null, tool_calls: [
                    { id: 'remember-1', type: 'function', function: { name: 'memory_write', arguments: '{"key":"language","value":"中文"}' } },
                ] };
            }
            if (request === 3) return { role: 'assistant', content: '已完成读取和记忆。' };
            expect(messages[0].content).toContain('中文');
            expect(messages.some(m => m.role === 'tool' && m.tool_call_id === 'read-1')).toBe(true);
            return { role: 'assistant', content: '记得使用中文。' };
        });
        const options = { home, cwd, sessionId: 'test-session', config, approve: async () => false };
        const events: PersonalEvent[] = [];
        await new PersonalEngine(options).turn('读取文件，并记住我偏好中文。', 'default', signal(), event => events.push(event));
        expect(new PersonalStore(home).memory()).toEqual({ language: '中文' });
        await new PersonalEngine(options).turn('我偏好什么语言？', 'default', signal(), event => events.push(event));
        expect(events.filter(e => e.type === 'tool-start')).toHaveLength(2);
        expect(events.at(-1)).toEqual({ type: 'text', text: '记得使用中文。' });
        expect(new PersonalStore(home).transcript('test-session').at(-1)?.content).toBe('记得使用中文。');
    });

    it('does not repeat a tool whose outcome was interrupted before persistence', async () => {
        const home = temp(), cwd = temp();
        new PersonalStore(home).save('interrupted', [
            { role: 'user', content: 'create file' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'write-1', type: 'function', function: {
                name: 'write_file', arguments: '{"path":"must-not-repeat.txt","content":"bad"}',
            } }] },
        ]);
        const config = await modelEndpoint(messages => {
            expect(messages.find(m => m.role === 'tool')?.content).toContain('outcome unknown');
            return { role: 'assistant', content: '需要先核实上次操作。' };
        });
        await new PersonalEngine({ home, cwd, sessionId: 'interrupted', config, approve: async () => true })
            .turn('继续', 'default', signal(), () => {});
        expect(existsSync(join(cwd, 'must-not-repeat.txt'))).toBe(false);
    });

    it('stops cancelled requests without starting another model call', async () => {
        const home = temp(), cwd = temp();
        let calls = 0;
        const config = await modelEndpoint(() => { calls++; return { role: 'assistant', content: 'unexpected' }; });
        const abort = new AbortController(); abort.abort();
        await expect(new PersonalEngine({ home, cwd, sessionId: 'cancelled', config, approve: async () => true })
            .turn('cancel', 'default', abort.signal, () => {})).rejects.toThrow();
        expect(calls).toBe(0);
    });
});

describe('Personal tool permissions and paths', () => {
    it('does not inherit another engine’s bypass permission alias', () => {
        expect(personalPermissionMode('bypassPermissions')).toBe('default');
        expect(personalPermissionMode('yolo')).toBe('yolo');
        expect(personalPermissionMode('read-only')).toBe('read-only');
    });
    it('gates real writes, rejects a symlink escape and respects read-only mode', async () => {
        const cwd = temp(), outside = temp(), store = new PersonalStore(temp());
        writeFileSync(join(outside, 'secret.txt'), 'outside');
        symlinkSync(join(outside, 'secret.txt'), join(cwd, 'escape.txt'));
        const tools = new PersonalTools(cwd, store, [], async () => false);
        await expect(tools.execute('a', 'read_file', { path: 'escape.txt' }, 'default', signal())).rejects.toThrow('outside');
        await expect(tools.execute('b', 'write_file', { path: 'new.txt', content: 'no' }, 'default', signal())).rejects.toThrow('declined');
        expect(existsSync(join(cwd, 'new.txt'))).toBe(false);
        await expect(tools.execute('c', 'memory_write', { key: 'x', value: 'y' }, 'read-only', signal())).rejects.toThrow('read-only');
        await expect(tools.execute('d', 'write_file', { path: 'escape.txt', content: 'no' }, 'yolo', signal())).rejects.toThrow('symlink');
        expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    });

    it('executes an approved command and returns the actual output', async () => {
        const tools = new PersonalTools(temp(), new PersonalStore(temp()), [], async () => true);
        await expect(tools.execute('exec', 'run_command', { command: 'node -e "process.stdout.write(String(21*2))"' }, 'default', signal()))
            .resolves.toMatchObject({ stdout: '42' });
    });
});

describe('Grok workflow archive installation', () => {
    it('installs namespaced adapters, retains source bytes and is idempotent', () => {
        const home = temp(), archive = join(temp(), 'skills.zip');
        const source = '---\nname: scheduling\ndescription: >-\n  Use for calendar planning.\n---\n# Scheduling\nUse SearchPlugins.\n';
        writeFileSync(archive, zipSync({ 'grok-bot-skills/scheduling/SKILL.md': strToU8(source),
            'grok-bot-skills/voice/SKILL.md': strToU8('---\nname: voice\ndescription: Use voice:<call> for live calls.\n---\n# Voice\n') }));
        const first = importGrokSkills(archive, home);
        const second = importGrokSkills(archive, home);
        expect(second).toEqual(first);
        expect(first.skills[0]).toMatchObject({ name: 'grok-scheduling', description: 'Use for calendar planning.', capability: 'requires-integration' });
        expect(first.skills[1].description).toBe('Use voice:call for live calls.');
        expect(readFileSync(join(first.skills[0].path, '..', 'references', 'upstream.md'), 'utf8')).toBe(source);
        expect(listPersonalSkills(home, temp()).some(skill => skill.name === 'grok-scheduling')).toBe(true);
    });

    it('rejects traversal entries and leaves no installation pointer', () => {
        const home = temp(), archive = join(temp(), 'unsafe.zip');
        writeFileSync(archive, zipSync({ 'grok-bot-skills/../../escape.md': strToU8('bad') }));
        expect(() => importGrokSkills(archive, home)).toThrow('Unsafe archive path');
        expect(existsSync(join(home, 'skills.json'))).toBe(false);
    });
});
