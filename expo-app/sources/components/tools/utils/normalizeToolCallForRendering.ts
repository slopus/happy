import type { ToolCall } from '@/sync/typesMessage';
import { maybeParseJson } from './parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeFilePathAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const currentFilePath = typeof input.file_path === 'string' ? input.file_path : null;
    const alias =
        typeof input.filePath === 'string'
            ? input.filePath
            : typeof input.path === 'string'
                ? input.path
                : null;
    if (!currentFilePath && alias) {
        return { ...input, file_path: alias };
    }
    return null;
}

function normalizeEditAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const maybeWithPath = normalizeFilePathAliases(input) ?? input;

    const hasOld = typeof maybeWithPath.old_string === 'string';
    const hasNew = typeof maybeWithPath.new_string === 'string';
    const oldAlias =
        typeof maybeWithPath.oldText === 'string'
            ? maybeWithPath.oldText
            : typeof maybeWithPath.oldString === 'string'
                ? maybeWithPath.oldString
                : null;
    const newAlias =
        typeof maybeWithPath.newText === 'string'
            ? maybeWithPath.newText
            : typeof maybeWithPath.newString === 'string'
                ? maybeWithPath.newString
                : null;

    const next: Record<string, unknown> = { ...maybeWithPath };
    let changed = maybeWithPath !== input;
    if (!hasOld && oldAlias) {
        next.old_string = oldAlias;
        changed = true;
    }
    if (!hasNew && newAlias) {
        next.new_string = newAlias;
        changed = true;
    }
    return changed ? next : null;
}

export function normalizeToolCallForRendering(tool: ToolCall): ToolCall {
    const parsedInput = maybeParseJson(tool.input);
    const parsedResult = maybeParseJson(tool.result);
    let nextInput: unknown = parsedInput;

    const inputRecord = asRecord(nextInput);
    if (inputRecord) {
        const toolNameLower = tool.name.toLowerCase();
        if (toolNameLower === 'edit') {
            nextInput = normalizeEditAliases(inputRecord) ?? inputRecord;
        } else if (toolNameLower === 'write' || toolNameLower === 'read') {
            nextInput = normalizeFilePathAliases(inputRecord) ?? inputRecord;
        }
    }

    const inputChanged = nextInput !== tool.input;
    const resultChanged = parsedResult !== tool.result;
    if (!inputChanged && !resultChanged) return tool;
    return { ...tool, input: nextInput, result: parsedResult };
}
