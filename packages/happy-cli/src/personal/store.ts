/** Private local memory and atomic per-session transcripts. Never replay an interrupted tool call. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatMessage } from './model';

export function writePersonalJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
}

const MemorySchema = z.record(z.string(), z.string().max(4000));
export class PersonalStore {
    constructor(readonly home: string) {}

    memory(): Record<string, string> {
        try { return MemorySchema.parse(JSON.parse(readFileSync(join(this.home, 'memory.json'), 'utf8'))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    }

    remember(key: string, value: string | null): void {
        if (!/^[\p{L}\p{N} _.-]{1,80}$/u.test(key)) throw new Error('Memory key must be 1–80 letters, digits, spaces, dots, hyphens or underscores');
        const memory = this.memory();
        if (value === null) delete memory[key];
        else {
            if (value.length > 4000) throw new Error('Memory value is too long');
            memory[key] = value;
        }
        if (Object.keys(memory).length > 100) throw new Error('Memory is limited to 100 entries');
        writePersonalJson(join(this.home, 'memory.json'), memory);
    }

    transcript(id: string): ChatMessage[] {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid Personal session ID');
        try {
            const messages = z.array(z.object({
                role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.string().nullable(),
                tool_call_id: z.string().optional(), reasoning_content: z.string().nullable().optional(),
                tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
            })).parse(JSON.parse(readFileSync(join(this.home, 'sessions', `${id}.json`), 'utf8')));
            // A crash may have happened after an external effect but before its result was saved.
            // Repair protocol continuity with an explicit unknown outcome; never invoke it again.
            for (let index = 0; index < messages.length; index++) {
                const calls = messages[index].tool_calls;
                if (!calls?.length) continue;
                let end = index + 1;
                while (messages[end]?.role === 'tool') end++;
                const answered = new Set(messages.slice(index + 1, end).map(message => message.tool_call_id));
                const missing = calls.filter(call => !answered.has(call.id)).map(call => ({ role: 'tool' as const,
                    tool_call_id: call.id, content: JSON.stringify({ error: 'Interrupted tool; outcome unknown. Verify the actual result before any retry.' }) }));
                messages.splice(end, 0, ...missing);
                index = end + missing.length - 1;
            }
            return messages;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }

    save(id: string, messages: ChatMessage[]): void {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid Personal session ID');
        writePersonalJson(join(this.home, 'sessions', `${id}.json`), messages);
    }
}
