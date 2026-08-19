import { describe, expect, it } from 'vitest';

import { getUserMessageDisplayText } from './messageDisplayText';

const runtimeStatus =
    'Happy has already applied these Codex runtime settings for this turn: model=gpt-5.6-sol, reasoning_effort=high. ' +
    'If the user asks to switch to one of these settings, acknowledge that it is already active; do not look for a tool or API to change it.';

describe('getUserMessageDisplayText', () => {
    it('hides marker-wrapped Happy system prompts while preserving the user request', () => {
        const text = [
            '<!-- happy:system-prompt:start -->',
            runtimeStatus,
            '<!-- happy:system-prompt:end -->',
            '',
            '我现在重新测试 Fork',
        ].join('\n');

        expect(getUserMessageDisplayText(text)).toBe('我现在重新测试 Fork');
    });

    it('hides every marker-wrapped block in a turn', () => {
        const text = [
            '<!-- happy:system-prompt:start -->',
            'internal options instructions',
            '<!-- happy:system-prompt:end -->',
            '',
            '保留这段用户输入',
            '',
            '<!-- happy:system-prompt:start -->',
            'internal title instructions',
            '<!-- happy:system-prompt:end -->',
        ].join('\n');

        expect(getUserMessageDisplayText(text)).toBe('保留这段用户输入');
    });

    it('hides the exact legacy unmarked runtime prefix from persisted conversations', () => {
        expect(getUserMessageDisplayText(`${runtimeStatus}\n\n我现在重新测试 Fork`))
            .toBe('我现在重新测试 Fork');
    });

    it('does not alter ordinary user-authored text', () => {
        const text = '为什么每轮会携带 model 和 reasoning_effort 参数？';

        expect(getUserMessageDisplayText(text)).toBe(text);
    });

    it('keeps malformed marker text visible instead of deleting user content', () => {
        const text = '<!-- happy:system-prompt:start -->\n这可能是用户粘贴的内容';

        expect(getUserMessageDisplayText(text)).toBe(text);
    });
});
