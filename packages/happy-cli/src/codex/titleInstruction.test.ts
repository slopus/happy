import { describe, expect, it } from 'vitest';

import { CODEX_CHANGE_TITLE_INSTRUCTION } from './titleInstruction';

describe('CODEX_CHANGE_TITLE_INSTRUCTION', () => {
  it('uses the Codex MCP tool name', () => {
    expect(CODEX_CHANGE_TITLE_INSTRUCTION).toContain('change_title');
    expect(CODEX_CHANGE_TITLE_INSTRUCTION).not.toContain('happy__change_title');
  });
});
