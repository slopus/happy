import { isSaycodePromptBlockEnabled, type SaycodePromptBlockOverrides } from '@/prompt/promptProvenance';
import { SAYCODE_API_GATEWAY_PROMPT } from '@/prompt/saycodeApiGatewayPrompt';

function joinPromptBlocks(blocks: Array<string | undefined>): string | undefined {
  const prompt = blocks.filter((block): block is string => Boolean(block)).join('\n\n');
  return prompt || undefined;
}

export function buildClaudeSystemPromptOptions({
  customSystemPrompt,
  appendSystemPrompt,
  chatTitlePrompt,
  saycodeSystemPrompt,
  agentOrchestrationPrompt,
  orchestratorPrompt,
  workerDelegationPrompt,
  connectorGuidance,
  checkpointGuidance,
  saycodeSystemPromptEnabled,
  saycodePromptBlocks,
}: {
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  /**
   * Instruction that makes the agent call `mcp__happy__change_title`. It is not
   * Saycode-owned behavioral guidance — it is how every client's chat list gets
   * a name — so it survives `saycodeSystemPromptEnabled: false`. Removing it
   * left the `change_title` tool registered with nothing telling the model to
   * call it, and chats stayed untitled.
   */
  chatTitlePrompt?: string;
  /** Co-Authored-By commit credits — gated per-block as 'coAuthoredCredit'. */
  saycodeSystemPrompt: string;
  /** Default-on child-session routing; gated per-block as 'agentOrchestration'. */
  agentOrchestrationPrompt?: string;
  orchestratorPrompt?: string;
  /** Gated per-block as 'workerDelegation'. */
  workerDelegationPrompt?: string;
  connectorGuidance?: string;
  checkpointGuidance?: string;
  saycodeSystemPromptEnabled?: boolean;
  /** Per-block overrides; default-on blocks do not inherit saycodeSystemPromptEnabled. */
  saycodePromptBlocks?: SaycodePromptBlockOverrides;
}): { customSystemPrompt?: string; appendSystemPrompt?: string } {
  const isCoAuthoredCreditEnabled = isSaycodePromptBlockEnabled(
    'coAuthoredCredit', saycodePromptBlocks, saycodeSystemPromptEnabled,
  );
  const isWorkerDelegationEnabled = isSaycodePromptBlockEnabled(
    'workerDelegation', saycodePromptBlocks, saycodeSystemPromptEnabled,
  );
  const isAgentOrchestrationEnabled = isSaycodePromptBlockEnabled(
    'agentOrchestration', saycodePromptBlocks, saycodeSystemPromptEnabled,
  );
  return {
    customSystemPrompt: customSystemPrompt
      ? joinPromptBlocks([customSystemPrompt, chatTitlePrompt, isCoAuthoredCreditEnabled ? saycodeSystemPrompt : undefined, checkpointGuidance])
      : undefined,
    appendSystemPrompt: joinPromptBlocks([
      appendSystemPrompt,
      chatTitlePrompt,
      isCoAuthoredCreditEnabled ? saycodeSystemPrompt : undefined,
      isAgentOrchestrationEnabled ? agentOrchestrationPrompt : undefined,
      orchestratorPrompt,
      isWorkerDelegationEnabled ? workerDelegationPrompt : undefined,
      connectorGuidance,
      checkpointGuidance,
      saycodeSystemPromptEnabled !== false ? SAYCODE_API_GATEWAY_PROMPT : undefined,
    ]),
  };
}
