import { describe, expect, it, vi } from 'vitest';
import { ToolCall } from '@/sync/typesMessage';
import {
    getToolActivityLabel,
    getTerminalToolCommand,
    getToolSummaryCategory,
    getToolSummaryDetail,
    isTerminalToolName,
    shouldRenderToolCardHeader,
} from './toolDisplay';

vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ''}`,
}));

function tool(name: string, input: unknown): ToolCall {
    return {
        name,
        state: 'completed',
        input,
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
    };
}

describe('terminal tool display helpers', () => {
    it('detects command-like terminal tools', () => {
        expect(isTerminalToolName('Bash')).toBe(true);
        expect(isTerminalToolName('CodexBash')).toBe(true);
        expect(isTerminalToolName('GeminiBash')).toBe(true);
        expect(isTerminalToolName('execute')).toBe(true);
        expect(isTerminalToolName('Read')).toBe(false);
    });

    it('extracts one-line command summaries from shell tools', () => {
        expect(getTerminalToolCommand(tool('Bash', { command: 'pnpm test' }))).toBe('pnpm test');

        expect(getTerminalToolCommand(tool(
            'CodexBash',
            {
                command: ['/usr/bin/zsh', '-lc', 'git status --short'],
                parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
            },
        ))).toBe('git status --short');
    });

    it('extracts Gemini execute titles without cwd metadata', () => {
        expect(getTerminalToolCommand(tool(
            'execute',
            { toolCall: { title: 'rm tmp.txt [current working directory /repo] (cleanup)' } },
        ))).toBe('rm tmp.txt');
    });

    it('hides Codex patch card headers on web only', () => {
        expect(shouldRenderToolCardHeader('CodexPatch', 'web')).toBe(false);
        expect(shouldRenderToolCardHeader('CodexPatch', 'ios')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexPatch', 'android')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexBash', 'web')).toBe(true);
    });

    it('classifies tools for compact transcript rows', () => {
        expect(getToolSummaryCategory('CodexBash')).toBe('terminal');
        expect(getToolSummaryCategory('CodexPatch')).toBe('edit');
        expect(getToolSummaryCategory('Read')).toBe('read');
        expect(getToolSummaryCategory('Grep')).toBe('search');
        expect(getToolSummaryCategory('WebFetch')).toBe('web');
    });

    it('extracts compact transcript row details', () => {
        expect(getToolSummaryDetail(tool('CodexBash', {
            command: ['/usr/bin/zsh', '-lc', 'git status --short'],
            parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
        }))).toBe('git status --short');

        expect(getToolSummaryDetail(tool('CodexPatch', {
            changes: {
                'README-RU.md': { kind: { type: 'update' } },
            },
        }))).toBe('README-RU.md');

        expect(getToolSummaryDetail(tool('MultiEdit', {
            file_path: '/repo/src/app.tsx',
        }))).toBe('/repo/src/app.tsx');
    });

    it('builds one human-readable label for compact activity rows', () => {
        expect(getToolActivityLabel(tool('CodexBash', {
            command: ['/usr/bin/zsh', '-lc', 'git status --short'],
            parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
        }))).toBe('toolGroup.ranCommands:1: git status --short');

        expect(getToolActivityLabel(tool('Read', {
            file_path: '/repo/src/app.tsx',
        }))).toBe('toolGroup.readFiles:1: /repo/src/app.tsx');

        const describedTool = tool('CodexPatch', {
            changes: { 'README.md': { kind: { type: 'update' } } },
        });
        describedTool.description = 'Updated the README';
        expect(getToolActivityLabel(describedTool)).toBe('Updated the README');

        expect(getToolActivityLabel(tool('mcp__linear__create_issue', {})))
            .toBe('MCP: Linear Create Issue');
    });
});
