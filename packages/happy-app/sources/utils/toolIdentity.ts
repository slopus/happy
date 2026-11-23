import { extractSkillNamesFromCommand } from '@slopus/happy-wire';
import type { ToolCall } from '@/sync/typesMessage';
import { stringifyToolCommand } from './toolCommand';

/** Identify Claude's document reads without changing the underlying tool or file navigation. */
export function getSkillDocumentName(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    if (tool.name !== 'Read') return null;
    const filePath = tool.input?.file_path ?? tool.input?.path;
    if (typeof filePath !== 'string' || /[\u0000-\u001f]/.test(filePath)) return null;
    const path = filePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    const name = path.match(/(?:^|\/)([^/]+)\/SKILL\.md$/)?.[1];
    return name && name !== '.' && name !== '..' ? name : null;
}

/** Repair old CLI records that labelled a whole compound terminal command as a Skill. */
export function getEffectiveToolName(tool: Pick<ToolCall, 'name' | 'input'>): string {
    if (tool.name !== 'Skill') return tool.name;
    const command = stringifyToolCommand(tool.input?.command);
    return command && extractSkillNamesFromCommand(command).length === 0 ? 'CodexBash' : tool.name;
}
