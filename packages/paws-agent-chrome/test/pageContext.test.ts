import { describe, expect, it } from 'vitest';
import { composePrompt } from '../src/pageContext';

describe('composePrompt', () => {
    const context = { title: 'Issue 42', url: 'https://example.com/issues/42', selection: 'boom\t  failed' };

    it('adds page identity and normalized selection when enabled', () => {
        expect(composePrompt('请修复', context, true)).toBe([
            '请修复',
            '',
            '网页上下文：',
            '- 标题：Issue 42',
            '- URL：https://example.com/issues/42',
            '',
            '选中内容：',
            'boom failed',
        ].join('\n'));
    });

    it('returns only the user message when context is disabled', () => {
        expect(composePrompt('  只聊天  ', context, false)).toBe('只聊天');
    });
});
