import { expect, it } from 'vitest';
import { buildContinuationContext } from './continuationContext';
const message = (text: string, createdAt = 1, extra = {}) => ({ id: String(createdAt), kind: 'user-text', text, createdAt, localId: null, ...extra } as any);
it('keeps recent conversation and inherited task context without thoughts or tool output', () => {
    const context = buildContinuationContext([message('latest'), message('private thought', 2, { kind: 'agent-text', isThinking: true }), message('tool secret', 3, { kind: 'tool-call' })], 'prior goal');
    expect(context).toContain('latest'); expect(context).toContain('prior goal');
    expect(context).not.toContain('private thought'); expect(context).not.toContain('tool secret');
});
it('bounds repeated continuations and retains multiline recent code and the latest request', () => {
    const context = buildContinuationContext([message('x'.repeat(40000)), message('fix\nparser()', 2)], 'p'.repeat(40000));
    expect(context.length).toBeLessThanOrEqual(24000);
    expect(context).toContain('fix\nparser()');
    expect(context).toContain('excerpt');
});
it('always includes the latest user task even when long assistant replies consume the excerpt budget', () => {
    const context = buildContinuationContext([message('Task ORCHID: fix empty CSV rows'), ...[2,3,4].map(n => message('reply'.repeat(1200), n, { kind: 'agent-text' }))]);
    expect(context).toContain('Task ORCHID: fix empty CSV rows');
    expect(context.length).toBeLessThanOrEqual(24000);
});
