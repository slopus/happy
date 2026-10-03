import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeChatArgs, runRestrictedClaude } from './restrictedClaude';
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture(events: object[], wait = false) {
    const cwd = await mkdtemp(join(tmpdir(), 'restricted-claude-')); folders.push(cwd);
    const binary = join(cwd, 'claude');
    await writeFile(binary, `#!/usr/bin/env node\nconst fs=require('fs');if(process.argv.includes('--version')){console.log('2.1.251 (Claude Code)');process.exit(0);}fs.writeFileSync(${JSON.stringify(join(cwd, 'args.json'))},JSON.stringify(process.argv.slice(2)));let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(join(cwd, 'input.json'))},input);for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));${wait ? 'setInterval(()=>{},1000);' : ''}});`, { mode: 0o700 });
    return { binary, cwd };
}
describe('restricted Claude Code process', () => {
    it('disables customization and tools, passes the model and images, and reports runtime model', async () => {
        const f = await fixture([{ type: 'system', subtype: 'init', model: 'resolved-sonnet', tools: [], mcp_servers: [] }, { type: 'result', subtype: 'success', result: 'hello' }]);
        let actualModel = '';
        expect(await runRestrictedClaude(f.binary, f.cwd, [{ role: 'user', text: 'hi', images: ['data:image/png;base64,YQ=='] }], new AbortController().signal, () => {}, 'sonnet', model => actualModel = model)).toBe('hello');
        expect(actualModel).toBe('resolved-sonnet');
        const args = JSON.parse(await readFile(join(f.cwd, 'args.json'), 'utf8'));
        for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) expect(args).toContain(flag);
        expect(args[args.indexOf('--tools') + 1]).toBe('');
        expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
        const input = JSON.parse(await readFile(join(f.cwd, 'input.json'), 'utf8'));
        expect(input.message.content.at(-1)).toMatchObject({ type: 'image', source: { data: 'YQ==', media_type: 'image/png' } });
    }, 15_000);
    it('rejects a runtime exposing tools', async () => {
        const f = await fixture([{ type: 'system', subtype: 'init', tools: ['Bash'] }], true);
        await expect(runRestrictedClaude(f.binary, f.cwd, [{ role: 'user', text: 'hi' }], new AbortController().signal, () => {}, 'sonnet')).rejects.toThrow('tool-surface');
    }, 15_000);
    it('cancels and waits for process exit', async () => {
        const f = await fixture([], true), controller = new AbortController();
        const pending = runRestrictedClaude(f.binary, f.cwd, [{ role: 'user', text: 'hi' }], controller.signal, () => {}, 'sonnet');
        setTimeout(() => controller.abort(), 300);
        await expect(pending).rejects.toThrow();
    }, 15_000);
    it('refuses arbitrary model/flag injection before spawn', () => expect(() => claudeChatArgs('--dangerously-skip-permissions')).toThrow());
});
