import { describe, it, expect } from 'vitest';
import { compareToolCalls } from './toolComparison';

describe('compareToolCalls', () => {
    it('should return true for identical tool calls', () => {
        const tool1 = { name: 'Read', arguments: { file_path: '/test.ts', limit: 10 } };
        const tool2 = { name: 'Read', arguments: { file_path: '/test.ts', limit: 10 } };
        expect(compareToolCalls(tool1, tool2)).toBe(true);
    });

    it('should return false for different tool names', () => {
        const tool1 = { name: 'Read', arguments: { file_path: '/test.ts' } };
        const tool2 = { name: 'Write', arguments: { file_path: '/test.ts' } };
        expect(compareToolCalls(tool1, tool2)).toBe(false);
    });

    it('should return false for different arguments', () => {
        const tool1 = { name: 'Read', arguments: { file_path: '/test1.ts' } };
        const tool2 = { name: 'Read', arguments: { file_path: '/test2.ts' } };
        expect(compareToolCalls(tool1, tool2)).toBe(false);
    });

    it('should handle null and undefined arguments', () => {
        expect(compareToolCalls(
            { name: 'Test', arguments: null },
            { name: 'Test', arguments: null }
        )).toBe(true);

        expect(compareToolCalls(
            { name: 'Test', arguments: undefined },
            { name: 'Test', arguments: undefined }
        )).toBe(true);

        expect(compareToolCalls(
            { name: 'Test', arguments: null },
            { name: 'Test', arguments: undefined }
        )).toBe(false);
    });

    it('should handle nested objects in arguments', () => {
        const tool1 = {
            name: 'Complex',
            arguments: {
                config: { timeout: 5000, retries: 3 },
                data: { items: [1, 2, 3] }
            }
        };
        const tool2 = {
            name: 'Complex',
            arguments: {
                config: { timeout: 5000, retries: 3 },
                data: { items: [1, 2, 3] }
            }
        };
        expect(compareToolCalls(tool1, tool2)).toBe(true);
    });

    it('should return false for different nested values', () => {
        const tool1 = {
            name: 'Complex',
            arguments: {
                config: { timeout: 5000, retries: 3 }
            }
        };
        const tool2 = {
            name: 'Complex',
            arguments: {
                config: { timeout: 5000, retries: 4 }
            }
        };
        expect(compareToolCalls(tool1, tool2)).toBe(false);
    });

    it('should handle arrays in arguments', () => {
        const tool1 = { name: 'Test', arguments: { items: [1, 2, 3] } };
        const tool2 = { name: 'Test', arguments: { items: [1, 2, 3] } };
        expect(compareToolCalls(tool1, tool2)).toBe(true);

        const tool3 = { name: 'Test', arguments: { items: [1, 2, 3] } };
        const tool4 = { name: 'Test', arguments: { items: [1, 3, 2] } };
        expect(compareToolCalls(tool3, tool4)).toBe(false);
    });

    it('should handle empty objects and arrays', () => {
        expect(compareToolCalls(
            { name: 'Test', arguments: {} },
            { name: 'Test', arguments: {} }
        )).toBe(true);

        expect(compareToolCalls(
            { name: 'Test', arguments: [] },
            { name: 'Test', arguments: [] }
        )).toBe(true);
    });

    it('should handle different property orders in objects', () => {
        const tool1 = { name: 'Test', arguments: { a: 1, b: 2 } };
        const tool2 = { name: 'Test', arguments: { b: 2, a: 1 } };
        expect(compareToolCalls(tool1, tool2)).toBe(true);
    });
});