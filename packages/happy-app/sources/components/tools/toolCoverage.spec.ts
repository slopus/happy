import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { knownTools } from './knownTools';
import { getToolSummaryCategory } from '@/utils/toolDisplay';

/**
 * Every tool name a producer can put on the wire, grouped by who emits it.
 * A name missing from both `knownTools` and the `toolDisplay` categories
 * renders as a generic wrench with a mechanically de-camel-cased label, which
 * is what "some tool calls look broken" reports come down to. Add new provider
 * tools here first — the test then tells you what else to fill in.
 */
const PRODUCER_TOOLS: Record<string, string[]> = {
    'Claude Code': [
        'Task', 'Agent', 'Bash', 'BashOutput', 'BashStop', 'KillShell', 'KillBash',
        'Edit', 'MultiEdit', 'Write', 'Read', 'Glob', 'Grep', 'LS',
        'NotebookEdit', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch',
        'ExitPlanMode', 'exit_plan_mode', 'EnterPlanMode', 'AskUserQuestion',
        'Skill', 'SlashCommand', 'ToolSearch', 'ListMcpResources', 'ReadMcpResource',
    ],
    'Claude Code orchestration': [
        'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
        'Workflow', 'ListAgents', 'SendMessage', 'Monitor', 'ScheduleWakeup',
        'RemoteTrigger', 'PushNotification', 'CronCreate', 'CronDelete', 'CronList',
        'EnterWorktree', 'ExitWorktree', 'EndConversation',
        'Artifact', 'SendUserFile', 'ReportFindings', 'DesignSync',
    ],
    'Codex (mapped by happy-cli)': [
        'CodexBash', 'CodexPatch', 'CodexDiff', 'CodexReasoning', 'CodexSubagent', 'change_title',
    ],
    'Codex raw shapes': [
        'apply_patch', 'search_replace', 'update_plan', 'exec_command', 'write_stdin',
        'read_file', 'list_dir', 'view_image', 'web_search', 'shell',
    ],
    'Happy Agent SDK': [
        'request_user_input', 'run_terminal_command', 'workflow', 'workflow_status',
        'stop_workflow', 'wait_for_workflow', 'create_agent', 'spawn_agent', 'agent_send',
        'agent_me', 'agent_info', 'wait_agent', 'interrupt_agent', 'list_agents',
        'followup_task', 'send_message', 'schedule_message', 'delegate_to_workspace',
        'create_workspace', 'archive_workspace', 'list_workspaces', 'list_workspace_sessions',
        'list_projects', 'create_goal', 'update_goal', 'get_goal', 'read_agent_history',
        'read_user_input', 'get_provider_usage', 'list_bots', 'create_bot', 'list_secrets',
        'web_fetch',
    ],
};

const registry = knownTools as Record<string, { icon?: unknown } | undefined>;

function hasIcon(name: string): boolean {
    return typeof registry[name]?.icon === 'function';
}

describe('tool rendering coverage', () => {
    for (const [producer, names] of Object.entries(PRODUCER_TOOLS)) {
        it(`gives every ${producer} tool an icon`, () => {
            const missing = names.filter((name) => !hasIcon(name));
            expect(missing).toEqual([]);
        });
    }

    it('categorizes every tool that names a file, a command or a search', () => {
        // Reasoning, plan and title tools legitimately have no activity
        // category; they are rendered from their `knownTools` entry alone.
        const uncategorized = new Set([
            'CodexReasoning', 'change_title', 'think', 'Skill', 'SlashCommand', 'ToolSearch',
            'TodoWrite', 'ExitPlanMode', 'exit_plan_mode', 'EnterPlanMode', 'EndConversation',
            'Artifact', 'SendUserFile', 'ReportFindings', 'DesignSync', 'read_user_input',
            'AskUserQuestion', 'request_user_input',
        ]);
        const uncovered = Object.values(PRODUCER_TOOLS)
            .flat()
            .filter((name) => !uncategorized.has(name) && getToolSummaryCategory(name) === 'other');
        expect(uncovered).toEqual([]);
    });
});
