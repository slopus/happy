import { saveDiffRecords, DiffRecord } from '../modules/common/diffStore';
import { saveToolOutputRecord } from '../modules/common/toolOutputStore';

/**
 * Trims toolUseResult payload before sending to App.
 * Removes large, unused data fields per tool to reduce payload size.
 *
 * Changes here must be validated against App-side rendering:
 * - typesRaw.ts:593 sets tool.result = toolUseResult (primary source)
 * - reducer.ts:808 assigns tool.result = c.content
 * - Each tool's view component has specific data expectations
 */
export function trimToolUseResult(
    toolName: string,
    toolUseResult: unknown,
    sessionId?: string,
    callId?: string
): unknown {
    if (toolUseResult == null) return toolUseResult;

    // Tools whose toolUseResult is completely unnecessary for App rendering.
    // Handles both string and object forms — e.g. LS returns a string listing.
    if (FULLY_TRIMMABLE_TUR.has(toolName)) {
        if (sessionId && callId && LOADABLE_TRIMMED_TOOLS.has(toolName)) {
            saveToolOutputRecord(sessionId, {
                callId,
                toolName,
                agent: 'claude',
                result: toolUseResult,
                timestamp: Date.now(),
            });
            return createTrimmedOutputMarker(toolName, callId);
        }
        return {};
    }

    // Non-object values (strings, numbers) for other tools: pass through unchanged.
    // e.g. Bash error strings, interrupted tool error messages.
    if (typeof toolUseResult !== 'object') {
        return toolUseResult;
    }

    const result = toolUseResult as Record<string, unknown>;
    let trimmed: unknown;

    switch (toolName) {
        // Edit/MultiEdit/Write: remove originalFile (~40KB avg, never used by App)
        // App renders diff from tool.input.old_string/new_string (assistant message)
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit': {
            const { originalFile, ...rest } = result;
            trimmed = rest;
            break;
        }

        // Read: App never renders content (minimal: true)
        // Keep only metadata for display
        case 'Read':
        case 'NotebookRead': {
            if (result.file && typeof result.file === 'object') {
                const file = result.file as Record<string, unknown>;
                trimmed = {
                    type: result.type,
                    file: {
                        filePath: file.filePath,
                        numLines: file.numLines,
                        startLine: file.startLine,
                        totalLines: file.totalLines,
                    },
                };
            } else {
                trimmed = { type: result.type };
            }
            break;
        }

        // Grep: App never renders content (minimal: true)
        // Remove match results, keep metadata
        case 'Grep': {
            const { content, ...rest } = result;
            trimmed = rest;
            break;
        }

        // Glob: App never renders content (minimal: true)
        // Remove filenames array, keep count
        case 'Glob': {
            const { filenames, ...rest } = result;
            trimmed = {
                ...rest,
                numFiles: Array.isArray(filenames) ? filenames.length : result.numFiles,
            };
            break;
        }

        // Task: TaskView reads child messages, not tool.result.content
        // Remove subagent output (up to 55KB), keep metadata
        case 'Task': {
            const { content, prompt, ...rest } = result;
            trimmed = rest;
            break;
        }

        // WebSearch: keep only query (used by Gemini's web_search for title)
        case 'WebSearch':
        case 'web_search':
            trimmed = { query: result.query };
            break;

        // Bash: keep as-is — BashViewFull needs stdout/stderr
        // TodoWrite: keep as-is — TodoView reads result.newTodos
        // AskUserQuestion: keep as-is
        // Unknown/MCP tools: keep as-is (safe default)
        default:
            return toolUseResult;
    }

    if (sessionId && callId && LOADABLE_TRIMMED_TOOLS.has(toolName)) {
        saveToolOutputRecord(sessionId, {
            callId,
            toolName,
            agent: 'claude',
            result: toolUseResult,
            timestamp: Date.now(),
        });
        return {
            ...(trimmed as Record<string, unknown>),
            ...createTrimmedOutputMarker(toolName, callId),
        };
    }

    return trimmed;
}

/** Tools whose toolUseResult can be entirely replaced with {} regardless of type */
const FULLY_TRIMMABLE_TUR = new Set([
    'LS', 'WebFetch', 'ToolSearch', 'Skill',
    'EnterPlanMode', 'enter_plan_mode',
]);

const LOADABLE_TRIMMED_TOOLS = new Set([
    'Read', 'NotebookRead', 'Grep', 'Glob', 'LS',
    'WebFetch', 'WebSearch', 'web_search',
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

function createTrimmedOutputMarker(toolName: string, callId: string): {
    _outputTrimmed: true;
    _callId: string;
    _toolResultKind: 'command' | 'structured' | 'text';
} {
    return {
        _outputTrimmed: true,
        _callId: callId,
        _toolResultKind: getToolResultKind(toolName),
    };
}

function getToolResultKind(toolName: string): 'command' | 'structured' | 'text' {
    switch (toolName) {
        case 'WebSearch':
        case 'web_search':
            return 'structured';
        default:
            return 'text';
    }
}

/**
 * Count added and deleted lines between two strings using LCS-based diff.
 * Only counts lines that actually changed, not unchanged context lines.
 * Falls back to raw line counts when input is too large for LCS (>1000 lines per side).
 */
function countLineChanges(oldStr: string, newStr: string): { additions: number; deletions: number } {
    if (!oldStr && !newStr) return { additions: 0, deletions: 0 };
    const oldLines = oldStr ? oldStr.split('\n') : [];
    const newLines = newStr ? newStr.split('\n') : [];
    // Strip trailing empty line from final newline
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
    if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
    if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
    const m = oldLines.length;
    const n = newLines.length;
    // Guard: skip LCS for very large inputs to avoid O(n*m) slowdown
    if (m > 1000 || n > 1000) return { additions: n, deletions: m };
    // LCS length via DP — Uint32Array avoids overflow for up to 1000 lines
    const prev = new Uint32Array(n + 1);
    const curr = new Uint32Array(n + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                curr[j] = prev[j - 1] + 1;
            } else {
                curr[j] = Math.max(prev[j], curr[j - 1]);
            }
        }
        prev.set(curr);
        curr.fill(0);
    }
    const lcs = prev[n];
    return { additions: n - lcs, deletions: m - lcs };
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
            const { additions, deletions } = countLineChanges(oldString, newString);

            saveDiffRecords(sessionId, [{
                callId,
                agent: 'claude',
                filePath,
                diff: JSON.stringify({ oldString, newString }),
                additions,
                deletions,
                timestamp: Date.now(),
            }]);

            return {
                ...block,
                input: {
                    file_path: filePath,
                    _trimmed: true,
                    callId,
                    additions,
                    deletions,
                },
            };
        }

        case 'Write': {
            const filePath = input.file_path;
            if (!filePath || typeof filePath !== 'string') return block;
            const content = typeof input.content === 'string' ? input.content : '';
            // Strip trailing newline to avoid off-by-one
            const lines = content ? content.replace(/\n$/, '').split('\n') : [];
            const additions = lines.length;

            saveDiffRecords(sessionId, [{
                callId,
                agent: 'claude',
                filePath,
                diff: JSON.stringify({ oldString: '', newString: content }),
                additions,
                deletions: 0,
                timestamp: Date.now(),
            }]);

            return {
                ...block,
                input: {
                    file_path: filePath,
                    _trimmed: true,
                    callId,
                    additions,
                    deletions: 0,
                },
            };
        }

        case 'MultiEdit': {
            const filePath = input.file_path;
            if (!filePath || typeof filePath !== 'string') return block;
            const edits = Array.isArray(input.edits) ? input.edits : [];
            if (edits.length === 0) return block;

            let totalAdditions = 0;
            let totalDeletions = 0;
            const records: DiffRecord[] = edits.map((edit: any, index: number) => {
                const oldStr = typeof edit.old_string === 'string' ? edit.old_string : '';
                const newStr = typeof edit.new_string === 'string' ? edit.new_string : '';
                const { additions, deletions } = countLineChanges(oldStr, newStr);
                totalAdditions += additions;
                totalDeletions += deletions;
                return {
                    callId,
                    agent: 'claude' as const,
                    filePath: `${filePath}#edit-${index}`,
                    diff: JSON.stringify({ oldString: oldStr, newString: newStr }),
                    additions,
                    deletions,
                    timestamp: Date.now(),
                };
            });

            saveDiffRecords(sessionId, records);

            return {
                ...block,
                input: {
                    file_path: filePath,
                    _trimmed: true,
                    callId,
                    editCount: edits.length,
                    additions: totalAdditions,
                    deletions: totalDeletions,
                },
            };
        }

        default:
            return block;
    }
}
