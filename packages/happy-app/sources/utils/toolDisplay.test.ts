import { describe, expect, it } from 'vitest';
import { ToolCall } from '@/sync/typesMessage';
import {
    getTerminalToolCommand,
    getToolSummaryCategory,
    getToolSummaryDetail,
    isInlineImageFileTool,
    isInlineVideoFileTool,
    isTerminalToolName,
    shouldRenderToolCardHeader,
} from './toolDisplay';

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

    it('identifies video file events that render as bare inline media', () => {
        expect(isInlineVideoFileTool(tool('file', { kind: 'video' }))).toBe(true);
        expect(isInlineVideoFileTool(tool('file', { kind: 'audio' }))).toBe(false);
        expect(isInlineVideoFileTool(tool('Read', { kind: 'video' }))).toBe(false);
    });

    it('identifies image file events that render without a protocol-level file header', () => {
        expect(isInlineImageFileTool(tool('file', { name: 'motion.jpg' }))).toBe(true);
        expect(isInlineImageFileTool(tool('file', { kind: 'image', name: 'still.jpg' }))).toBe(true);
        expect(isInlineImageFileTool(tool('file', { kind: 'file', name: 'report.pdf' }))).toBe(false);
        expect(isInlineImageFileTool(tool('file', { kind: 'audio', name: 'voice.m4a' }))).toBe(false);
        expect(isInlineImageFileTool(tool('Read', { kind: 'image' }))).toBe(false);
    });

    it('classifies tools for compact transcript rows', () => {
        expect(getToolSummaryCategory('CodexBash')).toBe('terminal');
        expect(getToolSummaryCategory('CodexPatch')).toBe('edit');
        expect(getToolSummaryCategory('Read')).toBe('read');
        expect(getToolSummaryCategory('Grep')).toBe('search');
        expect(getToolSummaryCategory('WebFetch')).toBe('web');
        expect(getToolSummaryCategory('Skill')).toBe('skill');
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

        expect(getToolSummaryDetail(tool('Skill', {
            skillNames: ['dev', 'obsidian-tools:ob-chat'],
        }))).toBe('dev, obsidian-tools:ob-chat');
    });
});
