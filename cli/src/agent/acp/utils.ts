/**
 * ACP Backend Utilities
 * 
 * Utility functions for working with ACP tool calls, tool names, and timeouts.
 */

/**
 * Known tool name patterns that can be extracted from toolCallId
 */
const KNOWN_TOOL_PATTERNS = {
  change_title: ['change_title', 'change-title', 'happy__change_title'],
  save_memory: ['save_memory', 'save-memory'],
  think: ['think'],
} as const;

/**
 * Check if a tool is an investigation tool based on toolCallId and toolKind
 * 
 * @param toolCallId - The tool call ID
 * @param toolKind - The tool kind/type
 * @returns true if this is an investigation tool
 */
export function isInvestigationTool(toolCallId: string, toolKind?: string | unknown): boolean {
  return toolCallId.includes('codebase_investigator') || 
         toolCallId.includes('investigator') ||
         (typeof toolKind === 'string' && toolKind.includes('investigator'));
}

/**
 * Extract tool name from toolCallId
 * 
 * Tool IDs often contain the tool name as a prefix (e.g., "change_title-1765385846663")
 * 
 * @param toolCallId - The tool call ID
 * @returns The extracted tool name, or null if not found
 */
export function extractToolNameFromId(toolCallId: string): string | null {
  const lowerId = toolCallId.toLowerCase();
  
  for (const [toolName, patterns] of Object.entries(KNOWN_TOOL_PATTERNS)) {
    for (const pattern of patterns) {
      if (lowerId.includes(pattern.toLowerCase())) {
        return toolName;
      }
    }
  }
  
  return null;
}

/**
 * Determine the real tool name from various sources
 * 
 * When ACP sends "other" or "Unknown tool", we try to determine the real name from:
 * 1. toolCallId (most reliable)
 * 2. input parameters
 * 3. params structure
 * 4. Context (first tool call after change_title instruction)
 * 
 * @param toolName - The initial tool name (may be "other" or "Unknown tool")
 * @param toolCallId - The tool call ID
 * @param input - The input parameters
 * @param params - The full params object
 * @param context - Context information (recent prompt had change_title, tool call count)
 * @returns The determined tool name
 */
export function determineToolName(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  params: unknown,
  context?: {
    recentPromptHadChangeTitle?: boolean;
    toolCallCountSincePrompt?: number;
  }
): string {
  // If tool name is already known, return it
  if (toolName !== 'other' && toolName !== 'Unknown tool') {
    return toolName;
  }
  
  // 1. Check toolCallId for known tool names (most reliable)
  const idToolName = extractToolNameFromId(toolCallId);
  if (idToolName) {
    return idToolName;
  }
  
  // 2. Check input for function names or tool identifiers
  if (input && typeof input === 'object') {
    const inputStr = JSON.stringify(input).toLowerCase();
    for (const [toolName, patterns] of Object.entries(KNOWN_TOOL_PATTERNS)) {
      for (const pattern of patterns) {
        if (inputStr.includes(pattern.toLowerCase())) {
          return toolName;
        }
      }
    }
  }
  
  // 3. Check params for additional clues
  const paramsStr = JSON.stringify(params).toLowerCase();
  for (const [toolName, patterns] of Object.entries(KNOWN_TOOL_PATTERNS)) {
    for (const pattern of patterns) {
      if (paramsStr.includes(pattern.toLowerCase())) {
        return toolName;
      }
    }
  }
  
  // 4. Context-based heuristic: if this is the first tool call after a prompt with change_title instruction
  // AND input is empty/minimal, it's likely change_title
  if (context?.recentPromptHadChangeTitle && context.toolCallCountSincePrompt === 0) {
    const isEmptyInput = !input || 
                         (Array.isArray(input) && input.length === 0) ||
                         (typeof input === 'object' && Object.keys(input).length === 0);
    
    if (isEmptyInput && toolName === 'other') {
      return 'change_title';
    }
  }
  
  // Return original tool name if we couldn't determine it
  return toolName;
}

/**
 * Get the real tool name from toolCallId, falling back to toolKind
 * 
 * @param toolCallId - The tool call ID
 * @param toolKind - The tool kind/type
 * @returns The real tool name
 */
export function getRealToolName(toolCallId: string, toolKind: string | unknown): string {
  const extracted = extractToolNameFromId(toolCallId);
  if (extracted) {
    return extracted;
  }
  return typeof toolKind === 'string' ? toolKind : 'unknown';
}

/**
 * Get timeout for a tool call based on its type
 * 
 * @param toolCallId - The tool call ID
 * @param toolKind - The tool kind/type
 * @returns Timeout in milliseconds
 */
export function getToolCallTimeout(toolCallId: string, toolKind: string | unknown): number {
  const isInvestigation = isInvestigationTool(toolCallId, toolKind);
  const isThinkTool = toolKind === 'think';
  
  if (isInvestigation) {
    return 600000; // 10 minutes for investigation tools (like codebase_investigator)
  } else if (isThinkTool) {
    return 30000; // 30s for regular think tools
  } else {
    return 120000; // 2min for other tools
  }
}

