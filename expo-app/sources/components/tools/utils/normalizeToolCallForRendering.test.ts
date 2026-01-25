import { describe, expect, it } from 'vitest';
import { normalizeToolCallForRendering } from './normalizeToolCallForRendering';

describe('normalizeToolCallForRendering', () => {
    it('parses JSON-string inputs/results into objects', () => {
        const tool = {
            name: 'unknown',
            state: 'running' as const,
            input: '{"a":1}',
            result: '[1,2,3]',
            createdAt: 0,
            startedAt: 0,
            completedAt: null,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized).not.toBe(tool);
        expect(normalized.input).toEqual({ a: 1 });
        expect(normalized.result).toEqual([1, 2, 3]);
    });

    it('returns the same reference when no parsing is needed', () => {
        const tool = {
            name: 'read',
            state: 'completed' as const,
            input: { file_path: '/etc/hosts' },
            result: { ok: true },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized).toBe(tool);
    });

    it('normalizes common edit aliases into old_string/new_string + file_path', () => {
        const tool = {
            name: 'edit',
            state: 'completed' as const,
            input: {
                filePath: '/tmp/a.txt',
                oldText: 'hello',
                newText: 'hi',
            },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
    });
});
