import { describe, it, expect } from 'vitest';
import { findActiveWord, findActiveWordString, getActiveWordQuery } from './findActiveWord';

describe('findActiveWord', () => {
    describe('basic prefix detection', () => {
        it('should detect @ mention at cursor', () => {
            const content = 'Hello @john';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@john', activeWord: '@john', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });

        it('should detect : emoji at cursor', () => {
            const content = 'I feel :happy';
            const selection = { start: 13, end: 13 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: ':happy', activeWord: ':happy', offset: 7, length: 6, activeLength: 6, endOffset: 13 });
        });

        it('should detect / command at cursor', () => {
            const content = 'Type /help for info';
            const selection = { start: 10, end: 10 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '/help', activeWord: '/help', offset: 5, length: 5, activeLength: 5, endOffset: 10 });
        });

        it('should detect # tag at cursor', () => {
            const content = 'This is #important';
            const selection = { start: 18, end: 18 };
            const result = findActiveWord(content, selection, ['@', ':', '/', '#']);
            expect(result).toEqual({ word: '#important', activeWord: '#important', offset: 8, length: 10, activeLength: 10, endOffset: 18 });
        });

        it('should return just the prefix when typed alone', () => {
            const content = 'Hello @';
            const selection = { start: 7, end: 7 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@', activeWord: '@', offset: 6, length: 1, activeLength: 1, endOffset: 7 });
        });
    });

    describe('word boundary detection', () => {
        it('should only detect prefix at word boundary', () => {
            const content = 'email@domain.com';
            const selection = { start: 16, end: 16 };
            const result = findActiveWord(content, selection);
            expect(result).toBeUndefined();
        });

        it('should detect prefix after space', () => {
            const content = 'Hello @user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });

        it('should detect prefix at start of line', () => {
            const content = '@user hello';
            const selection = { start: 5, end: 5 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 0, length: 5, activeLength: 5, endOffset: 5 });
        });

        it('should detect prefix after newline', () => {
            const content = 'Hello\n@user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });
    });

    describe('stop character handling', () => {
        it('should stop at newline', () => {
            const content = 'Hello\n@user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });

        it('should stop at comma', () => {
            const content = 'Hi, @user';
            const selection = { start: 9, end: 9 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 4, length: 5, activeLength: 5, endOffset: 9 });
        });

        it('should stop at parentheses', () => {
            const content = '(@user)';
            const selection = { start: 6, end: 6 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 1, length: 5, activeLength: 5, endOffset: 6 });
        });

        it('should stop at brackets', () => {
            const content = '[@user]';
            const selection = { start: 6, end: 6 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 1, length: 5, activeLength: 5, endOffset: 6 });
        });

        it('should stop at braces', () => {
            const content = '{@user}';
            const selection = { start: 6, end: 6 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 1, length: 5, activeLength: 5, endOffset: 6 });
        });

        it('should stop at angle brackets', () => {
            const content = '<@user>';
            const selection = { start: 6, end: 6 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 1, length: 5, activeLength: 5, endOffset: 6 });
        });

        it('should stop at semicolon', () => {
            const content = 'text;@user';
            const selection = { start: 10, end: 10 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 5, length: 5, activeLength: 5, endOffset: 10 });
        });
    });

    describe('multiple space handling', () => {
        it('should handle single space before prefix', () => {
            const content = 'Hello @user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });

        it('should stop at multiple spaces', () => {
            const content = 'Hello  @user';
            const selection = { start: 12, end: 12 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 7, length: 5, activeLength: 5, endOffset: 12 });
        });

        it('should handle spaces within active word search', () => {
            const content = 'text @user name';
            const selection = { start: 10, end: 10 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 5, length: 5, activeLength: 5, endOffset: 10 });
        });
    });

    describe('edge cases', () => {
        it('should return undefined when cursor at beginning', () => {
            const content = '@user';
            const selection = { start: 0, end: 0 };
            const result = findActiveWord(content, selection);
            expect(result).toBeUndefined();
        });

        it('should return undefined when text is selected', () => {
            const content = 'Hello @user';
            const selection = { start: 6, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toBeUndefined();
        });

        it('should handle empty content', () => {
            const content = '';
            const selection = { start: 0, end: 0 };
            const result = findActiveWord(content, selection);
            expect(result).toBeUndefined();
        });

        it('should handle cursor in middle of word without prefix', () => {
            const content = 'Hello world';
            const selection = { start: 8, end: 8 };
            const result = findActiveWord(content, selection);
            expect(result).toBeUndefined();
        });

        it('should handle prefix not in the prefix list', () => {
            const content = 'Hello $user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toBeUndefined();
        });
    });

    describe('custom prefixes', () => {
        it('should work with custom prefix array', () => {
            const content = 'Hello $user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection, ['$']);
            expect(result).toEqual({ word: '$user', activeWord: '$user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });

        it('should work with multiple custom prefixes', () => {
            const content1 = 'Hello $user';
            const selection1 = { start: 11, end: 11 };
            const result1 = findActiveWord(content1, selection1, ['$', '%']);
            expect(result1).toEqual({ word: '$user', activeWord: '$user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });

            const content2 = 'Hello %task';
            const selection2 = { start: 11, end: 11 };
            const result2 = findActiveWord(content2, selection2, ['$', '%']);
            expect(result2).toEqual({ word: '%task', activeWord: '%task', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });

        it('should use default prefixes when none provided', () => {
            const content = 'Hello @user';
            const selection = { start: 11, end: 11 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@user', activeWord: '@user', offset: 6, length: 5, activeLength: 5, endOffset: 11 });
        });
    });

    describe('cursor in middle of word', () => {
        it('should return full word and active part when cursor in middle', () => {
            const content = 'Hello @username!';
            const selection = { start: 10, end: 10 }; // cursor after @use
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ 
                word: '@username',      // Full word
                activeWord: '@use',     // Part up to cursor
                offset: 6,
                length: 9,
                activeLength: 4,
                endOffset: 15
            });
        });

        it('should handle cursor at different positions in word', () => {
            const content = 'Type @mention here';
            
            // Cursor after @m
            const result1 = findActiveWord(content, { start: 7, end: 7 });
            expect(result1).toEqual({
                word: '@mention',
                activeWord: '@m',
                offset: 5,
                length: 8,
                activeLength: 2,
                endOffset: 13
            });
            
            // Cursor after @ment
            const result2 = findActiveWord(content, { start: 10, end: 10 });
            expect(result2).toEqual({
                word: '@mention',
                activeWord: '@ment',
                offset: 5,
                length: 8,
                activeLength: 5,
                endOffset: 13
            });
        });

        it('should stop at stop characters after cursor', () => {
            const content = 'Hello @user, welcome';
            const selection = { start: 9, end: 9 }; // cursor after @us
            const result = findActiveWord(content, selection);
            expect(result).toEqual({
                word: '@user',
                activeWord: '@us',
                offset: 6,
                length: 5,
                activeLength: 3,
                endOffset: 11
            });
        });

        it('should handle word ending with space after cursor', () => {
            const content = 'Use :smile face';
            const selection = { start: 8, end: 8 }; // cursor after :smi
            const result = findActiveWord(content, selection);
            expect(result).toEqual({
                word: ':smile',
                activeWord: ':smi',
                offset: 4,
                length: 6,
                activeLength: 4,
                endOffset: 10
            });
        });
    });

    describe('complex scenarios', () => {
        it('should handle multiple prefixes in same line', () => {
            const content = 'Hey @john, use :smile: and /help';
            const selection1 = { start: 9, end: 9 };
            const result1 = findActiveWord(content, selection1);
            expect(result1).toEqual({ word: '@john', activeWord: '@john', offset: 4, length: 5, activeLength: 5, endOffset: 9 });

            const selection2 = { start: 22, end: 22 };
            const result2 = findActiveWord(content, selection2);
            expect(result2).toEqual({ word: ':smile:', activeWord: ':smile:', offset: 15, length: 7, activeLength: 7, endOffset: 22 });

            const selection3 = { start: 32, end: 32 };
            const result3 = findActiveWord(content, selection3);
            expect(result3).toEqual({ word: '/help', activeWord: '/help', offset: 27, length: 5, activeLength: 5, endOffset: 32 });
        });

        it('should handle prefix at end of text', () => {
            const content = 'Hello @';
            const selection = { start: 7, end: 7 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@', activeWord: '@', offset: 6, length: 1, activeLength: 1, endOffset: 7 });
        });

        it('should handle long active words', () => {
            const content = 'Hello @very_long_username_here';
            const selection = { start: 30, end: 30 };
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ word: '@very_long_username_here', activeWord: '@very_long_username_here', offset: 6, length: 24, activeLength: 24, endOffset: 30 });
        });

        it('should handle cursor positions within active word', () => {
            const content = 'Hello @username';
            const selection = { start: 10, end: 10 }; // cursor in middle of username
            const result = findActiveWord(content, selection);
            expect(result).toEqual({ 
                word: '@username',      // Full word
                activeWord: '@use',     // Part up to cursor
                offset: 6,
                length: 9,              // Full length
                activeLength: 4,        // Length up to cursor
                endOffset: 15           // Where the word ends
            });
        });
    });
});

describe('findActiveWordString', () => {
    it('should return just the word string for backward compatibility', () => {
        const content = 'Hello @john';
        const selection = { start: 11, end: 11 };
        const result = findActiveWordString(content, selection);
        expect(result).toBe('@john');
    });

    it('should return undefined when no active word', () => {
        const content = 'Hello world';
        const selection = { start: 11, end: 11 };
        const result = findActiveWordString(content, selection);
        expect(result).toBeUndefined();
    });
});

describe('getActiveWordQuery', () => {
    it('should extract query without prefix', () => {
        expect(getActiveWordQuery('@user')).toBe('user');
        expect(getActiveWordQuery(':smile')).toBe('smile');
        expect(getActiveWordQuery('/help')).toBe('help');
        expect(getActiveWordQuery('#tag')).toBe('tag');
    });

    it('should return empty string for just prefix', () => {
        expect(getActiveWordQuery('@')).toBe('');
        expect(getActiveWordQuery(':')).toBe('');
        expect(getActiveWordQuery('/')).toBe('');
        expect(getActiveWordQuery('#')).toBe('');
    });

    it('should handle empty string', () => {
        expect(getActiveWordQuery('')).toBe('');
    });

    it('should handle long queries', () => {
        expect(getActiveWordQuery('@very_long_username')).toBe('very_long_username');
    });
});