import { describe, it, expect } from 'vitest';
import { applySuggestion } from './applySuggestion';

describe('applySuggestion', () => {
    describe('basic replacement', () => {
        it('should replace @ mention at end of text', () => {
            const content = 'Hello @joh';
            const selection = { start: 10, end: 10 };
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith ',
                cursorPosition: 18  // Cursor after the space
            });
        });
        
        it('should replace : emoji at end of text', () => {
            const content = 'I feel :hap';
            const selection = { start: 11, end: 11 };
            const result = applySuggestion(content, selection, ':happy:');
            
            expect(result).toEqual({
                text: 'I feel :happy: ',
                cursorPosition: 15
            });
        });
        
        it('should replace / command at end of text', () => {
            const content = 'Type /hel';
            const selection = { start: 9, end: 9 };
            const result = applySuggestion(content, selection, '/help');
            
            expect(result).toEqual({
                text: 'Type /help ',
                cursorPosition: 11
            });
        });
    });
    
    describe('cursor in middle of word', () => {
        it('should replace entire word when cursor is in middle', () => {
            const content = 'Hello @username here';
            const selection = { start: 10, end: 10 }; // cursor after @use
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith here',
                cursorPosition: 17
            });
        });
        
        it('should handle cursor at beginning of word after prefix', () => {
            const content = 'Hello @username';
            const selection = { start: 7, end: 7 }; // cursor right after @
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith ',
                cursorPosition: 18  // Cursor after the space
            });
        });
    });
    
    describe('space handling', () => {
        it('should add space when there is more text after', () => {
            const content = 'Hello @user,welcome';
            const selection = { start: 11, end: 11 };
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith ,welcome',
                cursorPosition: 18  // Cursor after the space
            });
        });
        
        it('should not add double space if space already exists', () => {
            const content = 'Hello @user welcome';
            const selection = { start: 11, end: 11 };
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith welcome',
                cursorPosition: 17
            });
        });
        
        it('should respect addSpace parameter when false', () => {
            const content = 'Hello @user';
            const selection = { start: 11, end: 11 };
            const result = applySuggestion(content, selection, '@john_smith', ['@', ':', '/'], false);
            
            expect(result).toEqual({
                text: 'Hello @john_smith',
                cursorPosition: 17
            });
        });
    });
    
    describe('no active word', () => {
        it('should insert suggestion at cursor when no active word', () => {
            const content = 'Hello world';
            const selection = { start: 6, end: 6 };
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith world',
                cursorPosition: 18
            });
        });
        
        it('should handle text selection replacement', () => {
            const content = 'Hello world';
            const selection = { start: 6, end: 11 }; // "world" selected
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith ',
                cursorPosition: 18
            });
        });
    });
    
    describe('edge cases', () => {
        it('should handle empty content', () => {
            const content = '';
            const selection = { start: 0, end: 0 };
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: '@john_smith ',
                cursorPosition: 12
            });
        });
        
        it('should handle suggestion at start of text', () => {
            const content = '@use';
            const selection = { start: 4, end: 4 };
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: '@john_smith ',
                cursorPosition: 12
            });
        });
        
        it('should handle multiple words with same prefix', () => {
            const content = 'Hi @user1, meet @user2';
            const selection = { start: 9, end: 9 }; // cursor after @user1
            const result = applySuggestion(content, selection, '@alice');
            
            expect(result).toEqual({
                text: 'Hi @alice , meet @user2',
                cursorPosition: 10  // Cursor after the space
            });
        });
    });
    
    describe('custom prefixes', () => {
        it('should work with custom prefixes', () => {
            const content = 'Use $var';
            const selection = { start: 8, end: 8 };
            const result = applySuggestion(content, selection, '$variable', ['$']);
            
            expect(result).toEqual({
                text: 'Use $variable ',
                cursorPosition: 14
            });
        });
    });
    
    describe('stop characters', () => {
        it('should properly replace word before stop character', () => {
            const content = 'Hello @user!';
            const selection = { start: 11, end: 11 }; // cursor before !
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: 'Hello @john_smith !',
                cursorPosition: 18  // Cursor after the space
            });
        });
        
        it('should handle parentheses', () => {
            const content = '(@user)';
            const selection = { start: 6, end: 6 }; // cursor before )
            const result = applySuggestion(content, selection, '@john_smith');
            
            expect(result).toEqual({
                text: '(@john_smith )',
                cursorPosition: 13  // Cursor after the space
            });
        });
    });
});