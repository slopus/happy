import { describe, it, expect } from 'vitest';
import { normalizePathForKey } from './normalizePathForKey';

describe('normalizePathForKey', () => {
    it('should replace forward slashes with hyphens', () => {
        expect(normalizePathForKey('/Users/dev/project')).toBe('-Users-dev-project');
    });

    it('should replace underscores with hyphens', () => {
        expect(normalizePathForKey('/Users/dev/my_project')).toBe('-Users-dev-my-project');
        expect(normalizePathForKey('/Users/dev/trading_signals_bot')).toBe('-Users-dev-trading-signals-bot');
    });

    it('should replace dots with hyphens', () => {
        expect(normalizePathForKey('/Users/dev/my.project')).toBe('-Users-dev-my-project');
    });

    it('should preserve existing hyphens', () => {
        expect(normalizePathForKey('/Users/dev/car-log-plus')).toBe('-Users-dev-car-log-plus');
    });

    it('should keep consecutive hyphens (matching Claude Code behavior)', () => {
        // Claude Code does NOT collapse consecutive hyphens
        expect(normalizePathForKey('/Users/dev/a..b')).toBe('-Users-dev-a--b');
        expect(normalizePathForKey('/Users//dev///project')).toBe('-Users--dev---project');
    });

    it('should keep trailing hyphens (matching Claude Code behavior)', () => {
        // Claude Code does NOT strip trailing hyphens
        expect(normalizePathForKey('/Users/dev/project/')).toBe('-Users-dev-project-');
    });

    it('should replace spaces with hyphens', () => {
        expect(normalizePathForKey('/Users/John Doe/Documents/project')).toBe('-Users-John-Doe-Documents-project');
    });

    it('should replace colons with hyphens', () => {
        expect(normalizePathForKey('C:/Users/dev/project')).toBe('C--Users-dev-project');
    });

    it('should replace backslashes with hyphens (Windows paths)', () => {
        expect(normalizePathForKey('C:\\Users\\dev\\project')).toBe('C--Users-dev-project');
    });

    it('should replace tilde with hyphen (not strip it)', () => {
        // Claude Code treats ~ as any other non-alphanumeric char
        // ~/Documents → ~/ both become hyphens → --Documents
        expect(normalizePathForKey('~/Documents/project')).toBe('--Documents-project');
    });

    it('should replace Unicode characters with hyphens', () => {
        expect(normalizePathForKey('/Users/小明/projects')).toBe('-Users----projects');
    });

    it('should return empty string for empty input', () => {
        expect(normalizePathForKey('')).toBe('');
    });

    it('should match real-world Claude Code .claude/projects naming', () => {
        expect(normalizePathForKey('/Users/iml1s/Documents/mine/trading_signals_bot'))
            .toBe('-Users-iml1s-Documents-mine-trading-signals-bot');
        expect(normalizePathForKey('/Users/iml1s/Documents/mine/happy'))
            .toBe('-Users-iml1s-Documents-mine-happy');
        expect(normalizePathForKey('/Users/iml1s/Documents/mine/car-log-plus'))
            .toBe('-Users-iml1s-Documents-mine-car-log-plus');
    });
});
