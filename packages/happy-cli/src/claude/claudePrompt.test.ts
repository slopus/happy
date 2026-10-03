import { SAYCODE_API_GATEWAY_PROMPT } from '@/prompt/saycodeApiGatewayPrompt';
import { describe, expect, it } from 'vitest';
import { buildClaudeSystemPromptOptions } from './claudePrompt';

describe('buildClaudeSystemPromptOptions', () => {
  const input = {
    customSystemPrompt: 'USER CUSTOM',
    appendSystemPrompt: 'CLIENT APPEND',
    chatTitlePrompt: 'CHAT TITLE',
    saycodeSystemPrompt: 'SAYCODE BASE',
    agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
    orchestratorPrompt: 'ORCHESTRATOR',
    workerDelegationPrompt: 'WORKER DELEGATION',
    connectorGuidance: 'CONNECTOR FACTS',
  };

  it('preserves existing blocks and adds gateway guidance when enabled or absent', () => {
    const expected = {
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS' + '\n\n' + SAYCODE_API_GATEWAY_PROMPT,
    };

    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: true })).toEqual(expected);
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: undefined })).toEqual(expected);
  });

  it('removes only Saycode-owned blocks when disabled, keeping the chat title instruction', () => {
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: false })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    });
  });
});

describe('buildClaudeSystemPromptOptions with per-block overrides', () => {
  const input = {
    customSystemPrompt: 'USER CUSTOM',
    appendSystemPrompt: 'CLIENT APPEND',
    chatTitlePrompt: 'CHAT TITLE',
    saycodeSystemPrompt: 'SAYCODE BASE',
    agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
    orchestratorPrompt: 'ORCHESTRATOR',
    workerDelegationPrompt: 'WORKER DELEGATION',
    connectorGuidance: 'CONNECTOR FACTS',
  };

  it('keeps only the overridden-on block when the legacy value is off', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: { coAuthoredCredit: true },
    })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    });
  });

  it('removes child-session routing only when its block is explicitly off', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: { agentOrchestration: false },
    }).appendSystemPrompt).toBe(
      'CLIENT APPEND\n\nCHAT TITLE\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    );
  });

  it('drops only the overridden-off block when the legacy value is on', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: true,
      saycodePromptBlocks: { workerDelegation: false },
    })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nCONNECTOR FACTS' + '\n\n' + SAYCODE_API_GATEWAY_PROMPT,
    });
  });
});


describe('Saycode API gateway system guidance', () => {
  it.each([true, undefined])('discovers API suffixes through system instructions (master=%s)', (enabled) => {
    const result = buildClaudeSystemPromptOptions({
      saycodeSystemPrompt: '', appendSystemPrompt: 'PROJECT API CONTRACT',
      saycodeSystemPromptEnabled: enabled,
    });
    expect(result.appendSystemPrompt).toContain('{NAME}_SAYCODE_API_URL');
    expect(result.appendSystemPrompt).toContain('registered API contract');
    expect(result.appendSystemPrompt).toContain('PROJECT API CONTRACT');
    expect(result.appendSystemPrompt?.match(/<saycode-api-gateway>/g)).toHaveLength(1);
  });

  it('respects master OFF without losing project context', () => {
    expect(buildClaudeSystemPromptOptions({
      saycodeSystemPrompt: '', appendSystemPrompt: 'PROJECT API CONTRACT',
      saycodeSystemPromptEnabled: false,
    }).appendSystemPrompt).toBe('PROJECT API CONTRACT');
  });
});


it('includes active checkpoint facts with client instructions and leaves inactive guidance absent', () => {
  const active = buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', appendSystemPrompt: 'USER CONTEXT', checkpointGuidance: 'ACTIVE CHECKPOINT FACTS' });
  expect(active.appendSystemPrompt).toContain('ACTIVE CHECKPOINT FACTS'); expect(active.appendSystemPrompt).toContain('USER CONTEXT');
  const custom = buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', customSystemPrompt: 'USER CUSTOM', checkpointGuidance: 'ACTIVE CHECKPOINT FACTS' });
  expect(custom.customSystemPrompt).toBe('USER CUSTOM\n\nACTIVE CHECKPOINT FACTS');
  expect(buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', checkpointGuidance: '' }).appendSystemPrompt).not.toContain('CHECKPOINT');
});
