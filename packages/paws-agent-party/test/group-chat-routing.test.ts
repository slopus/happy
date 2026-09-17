import { describe, expect, it } from 'vitest';
import { resolveMentionTargets } from '../src/group-chat/routing.js';

const members = [
  { id: 'product', name: '产品经理', instructions: '关注用户需求与产品价值。', engine: 'codex' as const },
  { id: 'tech', name: '技术负责人', instructions: '关注实现成本、技术约束和开发路径。', engine: 'claude' as const },
  { id: 'critic', name: '质疑者', instructions: '寻找风险、漏洞与反例。', engine: 'gemini' as const },
];

describe('group-chat mention routing', () => {
  it('notifies only the explicitly mentioned room members and preserves their order', () => {
    expect(resolveMentionTargets('@产品经理 请 @技术负责人 一起看看', members, true)).toEqual({
      mode: 'mention', ids: ['product', 'tech'], unknown: [],
    });
  });

  it('does not fall back to automatic routing when a mentioned agent is not in this room', () => {
    expect(resolveMentionTargets('@研究员 帮我找资料', members, true)).toEqual({
      mode: 'invalid', ids: [], unknown: ['研究员'],
    });
  });

  it('records a plain message without waking any agent when automatic replies are disabled', () => {
    expect(resolveMentionTargets('先记下这个念头', members, false)).toEqual({
      mode: 'quiet', ids: [], unknown: [],
    });
  });

  it('uses a bounded relevant member when automatic replies are enabled', () => {
    expect(resolveMentionTargets('帮我判断实现成本和技术风险', members, true)).toEqual({
      mode: 'auto', ids: ['tech'], unknown: [],
    });
  });
});
