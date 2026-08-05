import { describe, expect, it } from 'vitest';
import { getMessageExecutionModeLabel } from './messageExecutionMode';

const translate = (key: string) => ({
    'agentInput.taskPermission.confirm': 'Needs confirmation',
    'agentInput.taskPermission.fullAccess': 'Full access',
} as Record<string, string>)[key] ?? key;

describe('getMessageExecutionModeLabel', () => {
    it('shows the actual friendly permission recorded on a historical message', () => {
        const historicalMeta = {
            permissionMode: 'acceptEdits',
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
        };

        expect(getMessageExecutionModeLabel(historicalMeta, 'codex', translate))
            .toBe('Needs confirmation · gpt-5.6-sol · xhigh');
    });

    it.each([
        { flavor: 'claude', permissionMode: 'bypassPermissions' },
        { flavor: 'codex', permissionMode: 'yolo' },
        { flavor: 'gemini', permissionMode: 'yolo' },
    ])('labels $flavor bypass authority as full access', ({ flavor, permissionMode }) => {
        expect(getMessageExecutionModeLabel({ permissionMode }, flavor, translate)).toBe('Full access');
    });

    it('does not invent a friendly permission claim for unsupported agents', () => {
        expect(getMessageExecutionModeLabel({ permissionMode: 'yolo', model: 'acp-model' }, 'opencode', translate))
            .toBe('acp-model');
    });

    it('keeps old messages without execution metadata unchanged', () => {
        expect(getMessageExecutionModeLabel(undefined, 'codex', translate)).toBeNull();
        expect(getMessageExecutionModeLabel({}, 'codex', translate)).toBeNull();
    });
});
