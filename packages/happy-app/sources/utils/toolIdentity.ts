import { extractSkillNamesFromCommand } from '@slopus/happy-wire';
import type { ToolCall } from '@/sync/typesMessage';
import { stringifyToolCommand } from './toolCommand';

/** Repair old CLI records that labelled a whole compound terminal command as a Skill. */
export function getEffectiveToolName(tool: Pick<ToolCall, 'name' | 'input'>): string {
    if (tool.name !== 'Skill') return tool.name;
    const command = stringifyToolCommand(tool.input?.command);
    return command && extractSkillNamesFromCommand(command).length === 0 ? 'CodexBash' : tool.name;
}
