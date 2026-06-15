import { describe, expect, it, vi } from 'vitest';
import { resolveInteractiveClaudeIdentity } from './sessionIdentity';

describe('resolveInteractiveClaudeIdentity', () => {
    it('generates a fresh session id and --session-id args when no resume flags are present', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--model', 'opus'],
            generateId: () => '11111111-1111-4111-8111-111111111111',
            findLastSession: vi.fn(),
        });

        expect(result).toEqual({
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
            launchArgs: ['--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'opus'],
            consumedArgs: ['--model', 'opus'],
            mode: 'fresh',
        });
    });

    it('uses explicit --resume uuid and removes the resume flag from passthrough args', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result.mode).toBe('resume');
        if (result.mode !== 'resume') {
            throw new Error('expected resume result');
        }
        expect(result.claudeSessionId).toBe('22222222-2222-4222-8222-222222222222');
        expect(result.launchArgs).toEqual(['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet']);
        expect(result.consumedArgs).toEqual(['--model', 'sonnet']);
    });

    it('resolves --continue to the latest concrete local session id', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--continue'],
            generateId: () => 'unused',
            findLastSession: () => '33333333-3333-4333-8333-333333333333',
        });

        expect(result.mode).toBe('continue');
        if (result.mode !== 'continue') {
            throw new Error('expected continue result');
        }
        expect(result.launchArgs).toEqual(['--resume', '33333333-3333-4333-8333-333333333333']);
    });

    it('uses explicit --session-id once when provided', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--session-id', '44444444-4444-4444-8444-444444444444', '--model', 'opus'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toEqual({
            claudeSessionId: '44444444-4444-4444-8444-444444444444',
            launchArgs: ['--session-id', '44444444-4444-4444-8444-444444444444', '--model', 'opus'],
            consumedArgs: ['--model', 'opus'],
            mode: 'fresh',
        });
    });

    it('returns unsupported when --continue has no local session', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--continue'],
            generateId: () => 'unused',
            findLastSession: () => null,
        });

        expect(result).toEqual({
            error: 'No local Claude session found for --continue.',
            mode: 'unsupported',
        });
    });

    it('returns unsupported for bare --resume without a session id', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--resume', '--model', 'opus'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toMatchObject({ mode: 'unsupported' });
    });

    it('returns unsupported for bare -r without a session id', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['-r'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toMatchObject({ mode: 'unsupported' });
    });

    it('returns unsupported for empty --resume= values', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--resume='],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toMatchObject({ mode: 'unsupported' });
    });

    it('returns unsupported for empty --session-id= values', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--session-id='],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toMatchObject({ mode: 'unsupported' });
    });

    it('returns unsupported when conflicting session-control flags are present', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--session-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--resume', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toMatchObject({ mode: 'unsupported' });
    });
});
