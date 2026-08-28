import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { knownTools } from './knownTools';

describe('knownTools', () => {
    it('hides Claude Skill tool calls from chat rendering', () => {
        expect((knownTools as Record<string, { hidden?: boolean }>).Skill?.hidden).toBe(true);
    });

    it('renders compact tools as one-line rows instead of raw JSON cards', () => {
        const registry = knownTools as Record<string, { minimal?: unknown }>;
        const names = [
            // Happy Agent SDK
            'TaskCreate', 'TaskUpdate', 'create_agent', 'web_fetch', 'web_search', 'create_workspace',
            // Claude Code shell session controls and orchestration
            'BashOutput', 'KillShell', 'ListAgents', 'ScheduleWakeup', 'SendUserFile',
            // Raw provider shapes we do not parse into a diff yet
            'apply_patch', 'exec_command', 'read_file',
        ];
        for (const name of names) {
            const minimal = registry[name]?.minimal;
            expect(typeof minimal, name).toBe('function');
            expect((minimal as Function)({ tool: { state: 'completed' } }), name).toBe(true);
        }
    });

    it('expands a compact tool that failed, so the error payload stays readable', () => {
        const minimal = (knownTools as Record<string, { minimal?: unknown }>).apply_patch?.minimal as Function;
        expect(minimal({ tool: { state: 'error', result: 'patch did not apply' } })).toBe(false);
        expect(minimal({ tool: { state: 'error', result: undefined } })).toBe(true);
    });

    it('gives every tool the app can receive an icon, so none falls back to a wrench', () => {
        const registry = knownTools as Record<string, { icon?: unknown }>;
        for (const name of Object.keys(registry)) {
            expect(typeof registry[name].icon, name).toBe('function');
        }
    });
});
