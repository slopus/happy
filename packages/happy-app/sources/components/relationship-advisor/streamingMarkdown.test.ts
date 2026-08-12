import { describe, expect, it } from 'vitest';

import { prepareRelationshipAdvisorStreamingMarkdown } from './streamingMarkdown';

describe('prepareRelationshipAdvisorStreamingMarkdown', () => {
    it('temporarily closes incomplete emphasis and inline code while streaming', () => {
        expect(prepareRelationshipAdvisorStreamingMarkdown('先看 **她的态度')).toBe('先看 **她的态度**');
        expect(prepareRelationshipAdvisorStreamingMarkdown('可以回 `刚看到')).toBe('可以回 `刚看到`');
    });

    it('shows incomplete link text without creating a temporary clickable URL', () => {
        expect(prepareRelationshipAdvisorStreamingMarkdown('参考 [这段话](https://example.com')).toBe('参考 这段话');
    });

    it('does not rewrite already complete markdown', () => {
        const complete = '**结论**\n\n- 先停一下\n- 不要追问';

        expect(prepareRelationshipAdvisorStreamingMarkdown(complete)).toBe(complete);
    });
});
