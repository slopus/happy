import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetToolTraceForTests, recordToolTraceEvent, ToolTraceWriter } from './toolTrace';

describe('ToolTraceWriter', () => {
    it('writes JSONL events', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-'));
        const filePath = join(dir, 'trace.jsonl');
        const writer = new ToolTraceWriter({ filePath });

        writer.record({
            v: 1,
            ts: 1700000000000,
            direction: 'outbound',
            sessionId: 'sess_123',
            protocol: 'acp',
            provider: 'codex',
            kind: 'tool-call',
            payload: { name: 'read', input: { filePath: '/etc/hosts' } },
        });

        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            v: 1,
            sessionId: 'sess_123',
            protocol: 'acp',
            provider: 'codex',
            kind: 'tool-call',
        });
    });
});

describe('recordToolTraceEvent', () => {
    it('writes multiple events to a single file when only DIR is set', () => {
        vi.useFakeTimers();
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-dir-'));
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_DIR = dir;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_FILE;
        __resetToolTraceForTests();

        vi.setSystemTime(new Date('2026-01-25T10:00:00.000Z'));
        recordToolTraceEvent({
            direction: 'outbound',
            sessionId: 'sess_1',
            protocol: 'acp',
            provider: 'codex',
            kind: 'tool-call',
            payload: { type: 'tool-call', name: 'read', input: { filePath: '/etc/hosts' } },
        });
        vi.setSystemTime(new Date('2026-01-25T10:00:01.000Z'));
        recordToolTraceEvent({
            direction: 'outbound',
            sessionId: 'sess_1',
            protocol: 'acp',
            provider: 'codex',
            kind: 'tool-result',
            payload: { type: 'tool-result', callId: 'c1', output: { ok: true } },
        });

        const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
        expect(files).toHaveLength(1);

        const raw = readFileSync(join(dir, files[0]), 'utf8');
        expect(raw.trim().split('\n')).toHaveLength(2);

        delete process.env.HAPPY_STACKS_TOOL_TRACE;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_DIR;
        __resetToolTraceForTests();
        vi.useRealTimers();
    });
});
