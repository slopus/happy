import { describe, expect, it } from 'vitest';
import { parseStructuredSummary } from './parseStructuredSummary';

const reply = '<analysis>\n部分完成，仍待核对原环境。\n</analysis>\n<summary>\n## 已完成\n候选构建已通过。\n</summary>';

describe('parseStructuredSummary', () => {
    it('recognizes the complete standalone Claude handoff shape without assigning thinking semantics', () => {
        expect(parseStructuredSummary(reply)).toEqual({ analysis: '部分完成，仍待核对原环境。', summary: '## 已完成\n候选构建已通过。' });
    });
    it('accepts CRLF and surrounding whitespace', () => {
        expect(parseStructuredSummary(` \n${reply.replaceAll('\n', '\r\n')}\n `)?.summary).toContain('候选构建');
    });
    it.each([
        '普通答复', `说明：\n${reply}`, `${reply}\n后续正常答复`,
        `\`\`\`xml\n${reply}\n\`\`\``, `> ${reply.replaceAll('\n', '\n> ')}`,
        reply.slice(0, -10), '<summary>\n普通 HTML 示例\n</summary>',
        '<analysis>inline</analysis>\n<summary>inline</summary>',
        '<analysis>\n说明\n</analysis>\n<summary>\n</summary>',
        '<analysis>\n<analysis>\n嵌套\n</analysis>\n</analysis>\n<summary>\n摘要\n</summary>',
        '<analysis>\n说明\n</analysis>\n额外正文\n<summary>\n摘要\n</summary>',
    ])('keeps prose, examples, incomplete or ambiguous structures unchanged: %s', text => {
        expect(parseStructuredSummary(text)).toBeNull();
    });
    it('ignores closing tags inside fenced code and preserves the code verbatim', () => {
        const summary = '示例：\n```xml\n</summary>\n<analysis>\n```\n后续说明';
        expect(parseStructuredSummary(`<analysis>\n说明\n</analysis>\n<summary>\n${summary}\n</summary>`)).toEqual({ analysis: '说明', summary });
    });
    it('preserves an indented code block at the beginning of a section', () => {
        const summary = '    const count = 1;\n    console.log(count);';
        expect(parseStructuredSummary(`<analysis>\n说明\n</analysis>\n<summary>\n${summary}\n</summary>`)?.summary).toBe(summary);
    });
    it('does not treat indented code tags as structural delimiters', () => {
        expect(parseStructuredSummary(reply.replaceAll('\n', '\n    ').replace('<analysis>', '    <analysis>'))).toBeNull();
    });
});
