import type { KnownToolDefinition } from './_types';
import { knownToolsCore } from './coreTools';
import { knownToolsProviders } from './providerTools';

export const knownTools = {
    ...knownToolsCore,
    ...knownToolsProviders,
} satisfies Record<string, KnownToolDefinition>;

/**
 * Check if a tool is mutable (can potentially modify files)
 * @param toolName The name of the tool to check
 * @returns true if the tool is mutable or unknown, false if it's read-only
 */
export function isMutableTool(toolName: string): boolean {
    const tool = knownTools[toolName as keyof typeof knownTools];
    if (tool) {
        if ('isMutable' in tool) {
            return tool.isMutable === true;
        } else {
            return false;
        }
    }
    // If tool is unknown, assume it's mutable to be safe
    return true;
}
