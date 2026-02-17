import { saveDiffRecords, DiffRecord } from '../modules/common/diffStore';

/**
 * Trims toolUseResult payload before sending to App.
 * Removes large, unused data fields per tool to reduce payload size.
 *
 * Changes here must be validated against App-side rendering:
 * - typesRaw.ts:593 sets tool.result = toolUseResult (primary source)
 * - reducer.ts:808 assigns tool.result = c.content
 * - Each tool's view component has specific data expectations
 */
export function trimToolUseResult(toolName: string, toolUseResult: unknown): unknown {
    if (toolUseResult == null) return toolUseResult;

    // Tools whose toolUseResult is completely unnecessary for App rendering.
    // Handles both string and object forms — e.g. LS returns a string listing.
    if (FULLY_TRIMMABLE_TUR.has(toolName)) {
        return {};
    }

    // Non-object values (strings, numbers) for other tools: pass through unchanged.
    // e.g. Bash error strings, interrupted tool error messages.
    if (typeof toolUseResult !== 'object') {
        return toolUseResult;
    }

    const result = toolUseResult as Record<string, unknown>;

    switch (toolName) {
        // Edit/MultiEdit/Write: remove originalFile (~40KB avg, never used by App)
        // App renders diff from tool.input.old_string/new_string (assistant message)
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit': {
            const { originalFile, ...rest } = result;
            return rest;
        }

        // Read: App never renders content (minimal: true)
        // Keep only metadata for display
        case 'Read':
        case 'NotebookRead': {
            if (result.file && typeof result.file === 'object') {
                const file = result.file as Record<string, unknown>;
                return {
                    type: result.type,
                    file: {
                        filePath: file.filePath,
                        numLines: file.numLines,
                        startLine: file.startLine,
                        totalLines: file.totalLines,
                    },
                };
            }
            return { type: result.type };
        }

        // Grep: App never renders content (minimal: true)
        // Remove match results, keep metadata
        case 'Grep': {
            const { content, ...rest } = result;
            return rest;
        }

        // Glob: App never renders content (minimal: true)
        // Remove filenames array, keep count
        case 'Glob': {
            const { filenames, ...rest } = result;
            return {
                ...rest,
                numFiles: Array.isArray(filenames) ? filenames.length : result.numFiles,
            };
        }

        // Task: TaskView reads child messages, not tool.result.content
        // Remove subagent output (up to 55KB), keep metadata
        case 'Task': {
            const { content, prompt, ...rest } = result;
            return rest;
        }

        // WebSearch: keep only query (used by Gemini's web_search for title)
        case 'WebSearch':
        case 'web_search':
            return { query: result.query };

        // Bash: keep as-is — BashViewFull needs stdout/stderr
        // TodoWrite: keep as-is — TodoView reads result.newTodos
        // AskUserQuestion: keep as-is
        // Unknown/MCP tools: keep as-is (safe default)
        default:
            return toolUseResult;
    }
}

/** Tools whose toolUseResult can be entirely replaced with {} regardless of type */
const FULLY_TRIMMABLE_TUR = new Set([
    'LS', 'WebFetch', 'ToolSearch', 'Skill',
    'EnterPlanMode', 'enter_plan_mode',
]);

const TRIMMABLE_TOOLS = new Set([
    'Read', 'NotebookRead', 'Grep', 'Glob', 'LS', 'Task',
    'WebFetch', 'WebSearch', 'web_search', 'ToolSearch',
    'Skill', 'EnterPlanMode', 'enter_plan_mode',
]);

/**
 * Trim the raw tool_result content (message.content[].content).
 * This is separate from toolUseResult — it's the Claude API format content
 * that also gets transmitted redundantly.
 * Content can be a string or an array of {type:'text', text:string}.
 */
export function trimToolResultContent(toolName: string, content: unknown): unknown {
    if (!TRIMMABLE_TOOLS.has(toolName)) return content;

    if (typeof content === 'string' && content.length >= 500) {
        return '[trimmed]';
    }

    if (Array.isArray(content)) {
        const totalLength = content.reduce((sum: number, item: any) =>
            sum + (typeof item?.text === 'string' ? item.text.length : 0), 0);
        if (totalLength >= 500) {
            return '[trimmed]';
        }
    }

    return content;
}

/**
 * Trim tool_use.input for Edit/Write/MultiEdit in assistant messages.
 * Extracts large strings (old_string, new_string, content), saves them to diffStore,
 * and replaces input with lightweight metadata. App fetches on demand via getDiffDetail RPC.
 *
 * Returns the original block unchanged for non-Edit/Write/MultiEdit tools.
 */
export function trimToolUseInput(
    block: { type: string; id: string; name: string; input: any },
    sessionId: string
): { type: string; id: string; name: string; input: any } {
    const { name, id: callId, input } = block;
    if (!input || typeof input !== 'object') return block;

    switch (name) {
        case 'Edit': {
            const filePath = input.file_path;
            if (!filePath || typeof filePath !== 'string') return block;
            const oldString = typeof input.old_string === 'string' ? input.old_string : '';
            const newString = typeof input.new_string === 'string' ? input.new_string : '';

            saveDiffRecords(sessionId, [{
                callId,
                agent: 'claude',
                filePath,
                diff: JSON.stringify({ oldString, newString }),
                additions: 0,
                deletions: 0,
                timestamp: Date.now(),
            }]);

            return {
                ...block,
                input: {
                    file_path: filePath,
                    _trimmed: true,
                    callId,
                },
            };
        }

        case 'Write': {
            const filePath = input.file_path;
            if (!filePath || typeof filePath !== 'string') return block;
            const content = typeof input.content === 'string' ? input.content : '';

            saveDiffRecords(sessionId, [{
                callId,
                agent: 'claude',
                filePath,
                diff: JSON.stringify({ oldString: '', newString: content }),
                additions: 0,
                deletions: 0,
                timestamp: Date.now(),
            }]);

            return {
                ...block,
                input: {
                    file_path: filePath,
                    _trimmed: true,
                    callId,
                },
            };
        }

        case 'MultiEdit': {
            const filePath = input.file_path;
            if (!filePath || typeof filePath !== 'string') return block;
            const edits = Array.isArray(input.edits) ? input.edits : [];
            if (edits.length === 0) return block;

            const records: DiffRecord[] = edits.map((edit: any, index: number) => ({
                callId,
                agent: 'claude' as const,
                filePath: `${filePath}#edit-${index}`,
                diff: JSON.stringify({
                    oldString: typeof edit.old_string === 'string' ? edit.old_string : '',
                    newString: typeof edit.new_string === 'string' ? edit.new_string : '',
                }),
                additions: 0,
                deletions: 0,
                timestamp: Date.now(),
            }));

            saveDiffRecords(sessionId, records);

            return {
                ...block,
                input: {
                    file_path: filePath,
                    _trimmed: true,
                    callId,
                    editCount: edits.length,
                },
            };
        }

        default:
            return block;
    }
}
