import { describe, expect, it } from 'vitest';
import { readClaudeConversation, readCodexConversation, toCodexItems, toClaudeLines } from './history';
const user = (uuid: string, parentUuid: string | null, content: unknown) => ({ uuid, parentUuid, type: 'user', message: { role: 'user', content } });

describe('cross-agent native conversation conversion', () => {
    it('follows the Claude main branch, preserves image and tool results, excludes thinking', () => {
        const rows = [user('u', null, [{ type: 'text', text: '<real user XML>' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }]),
            { uuid: 'a', parentUuid: 'u', type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'pwd' } }] } },
            user('r', 'a', [{ type: 'tool_result', tool_use_id: 'tool-1', content: '/work' }]),
            { ...user('side', 'r', 'private sidechain'), isSidechain: true }];
        const history = readClaudeConversation(rows);
        const encoded = JSON.stringify(toCodexItems(history, '/work'));
        expect(encoded).toContain('<real user XML>'); expect(encoded).toContain('data:image/png;base64,aGVsbG8=');
        expect(encoded).toContain('exec_command'); expect(encoded).toContain('/work');
        expect(encoded).not.toContain('secret'); expect(encoded).not.toContain('private sidechain');
        const calls = toCodexItems(history, '/work') as any[];
        expect(calls.find(x => x.type === 'function_call').call_id).toBe(calls.find(x => x.type === 'function_call_output').call_id);
    });
    it('turns foreign tools into historical text, never executable target tools', () => {
        const history = readClaudeConversation([user('u', null, 'edit'), { uuid: 'a', parentUuid: 'u', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', id: 'edit', input: { path: 'a.ts' } }] } }, user('r', 'a', [{ type: 'tool_result', tool_use_id: 'edit', content: 'edited' }])]);
        const items = toCodexItems(history, '/work') as any[];
        expect(items.some(x => x.type === 'function_call')).toBe(false);
        expect(JSON.stringify(items)).toContain('edited');
    });
    it('converts Codex structured history to Claude, stripping injected Happy instructions only', () => {
        const history = readCodexConversation({ id: 'thread', turns: [{ id: 'turn', items: [
            { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '<xml>user</xml>\n<!-- happy:system-prompt:start -->old model settings<!-- happy:system-prompt:end -->' }] },
            { type: 'reasoning', id: 'r', content: ['private'] },
            { type: 'commandExecution', id: 'c', command: 'pwd', cwd: '/work', aggregatedOutput: '/work', exitCode: 0, status: 'completed' },
            { type: 'agentMessage', id: 'a', text: 'done' },
        ] }] });
        const rows = toClaudeLines(history, { id: 'new-id', cwd: '/work' }) as any[];
        expect(rows[0].parentUuid).toBe(null);
        expect(rows.every((row, i) => i === 0 || row.parentUuid === rows[i - 1].uuid)).toBe(true);
        expect(JSON.stringify(rows)).toContain('Bash'); expect(JSON.stringify(rows)).toContain('<xml>user</xml>');
        expect(JSON.stringify(rows)).not.toContain('old model settings'); expect(JSON.stringify(rows)).not.toContain('private');
        expect(rows.filter(x => x.type === 'assistant').every(x => x.message.model === '<synthetic>' && x.message.usage.output_tokens === 0)).toBe(true);
    });
    it('rejects incomplete chains, running tool records and unknown context-bearing items instead of silently dropping them', () => {
        expect(() => readClaudeConversation([user('u', 'missing', 'task')])).toThrow(/history|chain/i);
        expect(() => readClaudeConversation([user('u', null, 'task'), { uuid: 'a', parentUuid: 'u', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'sleep 10' } }] } }])).toThrow(/unfinished|result/i);
        expect(() => readCodexConversation({ id: 't', turns: [{ id: 'turn', items: [{ type: 'newUnknownItem', id: 'x' }] }] })).toThrow(/unsupported/i);
    });
});

it.each(['completed', 'failed', 'declined'])('imports terminal Codex commands with omitted output (%s) without replaying them', status => {
 const history = readCodexConversation({ id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
  { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'run a command' }] },
  { type: 'commandExecution', id: 'c', command: 'pwd', cwd: '/work', status, aggregatedOutput: null, exitCode: status === 'completed' ? 0 : null },
 ] }] });
 expect(history[1]).toMatchObject({kind:'tool', command:'pwd', error:status !== 'completed'});
 expect((history[1] as any).output).toMatch(/not retained/i);
 expect(JSON.stringify(toClaudeLines(history,{id:'new',cwd:'/work'}))).toContain('not retained');
});
it('still rejects running and unverified command records with missing output', () => {
 for (const status of ['inProgress', undefined, 'unknown']) expect(() => readCodexConversation({id:'t',turns:[{id:'turn',status:'completed',items:[{type:'commandExecution',id:'c',command:'pwd',status,aggregatedOutput:null}]}]})).toThrow(/unfinished/i);
 expect(() => readCodexConversation({id:'t',turns:[{id:'turn',status:'inProgress',items:[]}]})).toThrow(/finish/i);
});

it('preserves native sub-agent activity and sleep as historical notes only', () => {
 const h=readCodexConversation({id:'t',turns:[{id:'turn',status:'completed',items:[
 {type:'subAgentActivity',id:'a',kind:'spawn',agentThreadId:'child',completedAtMs:2},
 {type:'sleep',id:'s',durationMs:100},
 ]}]} as any);
 expect(h.map(x=>x.kind)).toEqual(['assistant','assistant']);
 expect(JSON.stringify(h)).toContain('subAgentActivity');expect(JSON.stringify(h)).toContain('sleep');
 expect((toCodexItems(h,'/work') as any[]).every(x=>x.type==='message')).toBe(true);
});
