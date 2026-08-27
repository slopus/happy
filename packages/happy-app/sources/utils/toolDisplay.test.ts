import { describe, expect, it, vi } from 'vitest';
import { ToolCall } from '@/sync/typesMessage';
import {
    getToolActivityLabel,
    getTerminalToolCommand,
    getToolSummaryCategory,
    getToolSummaryDetail,
    hasRenderableQuestionContent,
    isTerminalToolName,
    shouldRenderToolCardHeader,
    shouldUseCompactToolRow,
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
        expect(isTerminalToolName('exec_command')).toBe(true);
        expect(isTerminalToolName('run_terminal_command')).toBe(true);
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

    it('renders every edit-shaped tool as a headerless inline ribbon', () => {
        for (const editTool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'CodexPatch', 'CodexDiff']) {
            for (const platform of ['web', 'ios', 'android']) {
                expect(shouldRenderToolCardHeader(editTool, platform)).toBe(false);
            }
        }
        expect(shouldRenderToolCardHeader('CodexBash', 'web')).toBe(true);
    });

    it('classifies tools for compact transcript rows', () => {
        expect(getToolSummaryCategory('CodexBash')).toBe('terminal');
        expect(getToolSummaryCategory('exec_command')).toBe('terminal');
        expect(getToolSummaryCategory('CodexPatch')).toBe('edit');
        expect(getToolSummaryCategory('apply_patch')).toBe('edit');
        expect(getToolSummaryCategory('Read')).toBe('read');
        expect(getToolSummaryCategory('read_agent_history')).toBe('read');
        expect(getToolSummaryCategory('Grep')).toBe('search');
        expect(getToolSummaryCategory('list_workspaces')).toBe('search');
        expect(getToolSummaryCategory('WebFetch')).toBe('web');
        expect(getToolSummaryCategory('spawn_agent')).toBe('task');
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

        expect(getToolSummaryDetail(tool('exec_command', {
            cmd: 'pnpm test',
        }))).toBe('pnpm test');

        expect(getToolSummaryDetail(tool('read_file', {
            target_file: '/repo/src/app.tsx',
        }))).toBe('/repo/src/app.tsx');
    });

    it('builds one human-readable label for compact activity rows', () => {
        // Terminal rows are the bare command; the icon already says "terminal".
        expect(getToolActivityLabel(tool('CodexBash', {
            command: ['/usr/bin/zsh', '-lc', 'git status --short'],
            parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
        }))).toBe('git status --short');

        expect(getToolActivityLabel(tool('Bash', { command: 'pnpm test' }))).toBe('pnpm test');

        // A terminal tool with no extractable command still gets the action label.
        expect(getToolActivityLabel(tool('write_stdin', {})))
            .toBe('toolGroup.ranCommands:1');

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

        const rigCommand = tool('exec_command', { cmd: 'git status --short' });
        rigCommand.description = 'Running Exec Command';
        expect(getToolActivityLabel(rigCommand)).toBe('git status --short');

        const rigCoordination = tool('spawn_agent', {});
        rigCoordination.description = 'Running Spawn Agent';
        expect(getToolActivityLabel(rigCoordination)).toBe('Spawn Agent');

        const futureTool = tool('brand_new_rig_tool', {});
        futureTool.description = 'Running Brand New Rig Tool';
        expect(getToolActivityLabel(futureTool)).toBe('Brand New Rig Tool');
    });

    it('uses compact rows for current and future non-interactive tools', () => {
        expect(shouldUseCompactToolRow(tool('exec_command', {}), true)).toBe(true);
        expect(shouldUseCompactToolRow(tool('brand_new_rig_tool', {}), true)).toBe(true);
        for (const richEditTool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'CodexPatch', 'CodexDiff']) {
            expect(shouldUseCompactToolRow(tool(richEditTool, {}), true)).toBe(false);
        }
        expect(shouldUseCompactToolRow(tool('apply_patch', {}), true)).toBe(true);
        expect(shouldUseCompactToolRow(tool('search_replace', {}), true)).toBe(true);
        expect(shouldUseCompactToolRow(tool('brand_new_rig_tool', {}), false)).toBe(false);
        expect(shouldUseCompactToolRow(tool('file', {}), true)).toBe(false);
        expect(shouldUseCompactToolRow(tool('AskUserQuestion', {}), true)).toBe(false);
        expect(shouldUseCompactToolRow(tool('request_user_input', {}), true)).toBe(false);

        const pendingPlan = tool('ExitPlanMode', {});
        pendingPlan.permission = {
            id: 'permission-1',
            status: 'pending',
        };
        expect(shouldUseCompactToolRow(pendingPlan, true)).toBe(false);
        pendingPlan.permission.status = 'approved';
        expect(shouldUseCompactToolRow(pendingPlan, true)).toBe(true);
    });

    it('detects question content the inline form can render', () => {
        expect(hasRenderableQuestionContent({ questions: [{ question: 'Where?' }] })).toBe(true);
        expect(hasRenderableQuestionContent({ question: 'Where?' })).toBe(true);
        expect(hasRenderableQuestionContent({ input: { questions: [{ question: 'Where?' }] } })).toBe(true);
        // Malformed input falls back to the ordinary tool card so the
        // permission footer stays reachable.
        expect(hasRenderableQuestionContent({ questions: [] })).toBe(false);
        expect(hasRenderableQuestionContent({})).toBe(false);
        expect(hasRenderableQuestionContent(undefined)).toBe(false);
        expect(hasRenderableQuestionContent('AskUserQuestion')).toBe(false);
    });
});
