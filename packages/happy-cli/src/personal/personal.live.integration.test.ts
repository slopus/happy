/** Opt-in actual model validation. Uses the configured gateway and an isolated workspace/memory. */
import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalEngine, type PersonalEvent } from './engine';
import { loadPersonalConfig } from './config';
import { PersonalStore } from './store';

it.skipIf(process.env.PAWS_PERSONAL_LIVE !== '1')('reads a real file, runs a tool, and remembers across model/engine restarts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'paws-personal-live-memory-'));
    const cwd = mkdtempSync(join(tmpdir(), 'paws-personal-live-workspace-'));
    try {
        const value = `PAWS_${Date.now()}`;
        writeFileSync(join(cwd, 'verification.txt'), value);
        const config = loadPersonalConfig();
        const events: PersonalEvent[] = [];
        const opts = { home, cwd, sessionId: 'live-verification', config, approve: async () => true };
        await new PersonalEngine(opts).turn('这是在隔离临时目录中的引擎验收。请实际调用read_file读取verification.txt，把文件的原样内容通过memory_write保存到键verification，再通过write_file写入result.txt（不加换行）。三个工具都必须执行，不要用shell。最后简短报告。',
            'default', new AbortController().signal, event => events.push(event));
        expect(readFileSync(join(cwd, 'result.txt'), 'utf8')).toBe(value);
        expect(new PersonalStore(home).memory().verification).toBe(value);
        expect(events.filter(event => event.type === 'tool-start').map(event => event.name))
            .toEqual(expect.arrayContaining(['read_file', 'memory_write', 'write_file']));
        let reply = '';
        await new PersonalEngine({ ...opts, sessionId: 'new-conversation' }).turn('请读取记忆，告诉我verification的原样值，只输出值。',
            'read-only', new AbortController().signal, event => { if (event.type === 'text') reply += event.text; });
        expect(reply).toContain(value);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
}, 180_000);
