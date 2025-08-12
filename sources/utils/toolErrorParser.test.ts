import { describe, it, expect } from 'vitest';
import { parseToolUseError, parseAllToolUseErrors, hasToolUseError } from './toolErrorParser';

describe('toolErrorParser', () => {
    describe('parseToolUseError', () => {
        it('should parse tool use error correctly', () => {
            const input = '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(true);
            expect(result.errorMessage).toBe('File has not been read yet. Read it first before writing to it.');
        });

        it('should handle normal error messages', () => {
            const input = 'This is a regular error message';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(false);
            expect(result.errorMessage).toBe(null);
        });

        it('should handle empty tool use error tags', () => {
            const input = '<tool_use_error></tool_use_error>';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(true);
            expect(result.errorMessage).toBe('');
        });

        it('should handle multiline content', () => {
            const input = '<tool_use_error>Error:\nLine 1\nLine 2</tool_use_error>';
            const result = parseToolUseError(input);
            
            expect(result.isToolUseError).toBe(true);
            expect(result.errorMessage).toBe('Error:\nLine 1\nLine 2');
        });

        it('should handle non-string input', () => {
            const result = parseToolUseError(null as any);
            
            expect(result.isToolUseError).toBe(false);
            expect(result.errorMessage).toBe(null);
        });
    });

    describe('parseAllToolUseErrors', () => {
        it('should extract multiple tool use errors', () => {
            const input = '<tool_use_error>Error 1</tool_use_error> some text <tool_use_error>Error 2</tool_use_error>';
            const result = parseAllToolUseErrors(input);
            
            expect(result).toEqual(['Error 1', 'Error 2']);
        });

        it('should return empty array for no matches', () => {
            const input = 'No tool use errors here';
            const result = parseAllToolUseErrors(input);
            
            expect(result).toEqual([]);
        });
    });

    describe('hasToolUseError', () => {
        it('should return true when tool use error present', () => {
            const input = '<tool_use_error>Some error</tool_use_error>';
            expect(hasToolUseError(input)).toBe(true);
        });

        it('should return false when no tool use error', () => {
            const input = 'Regular error message';
            expect(hasToolUseError(input)).toBe(false);
        });
    });
});