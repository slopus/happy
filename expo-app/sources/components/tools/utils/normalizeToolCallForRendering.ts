import type { ToolCall } from '@/sync/typesMessage';
import { maybeParseJson } from './parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = asRecord(locations[0]);
    if (!first) return null;
    return (
        firstNonEmptyString(first.path) ??
        firstNonEmptyString(first.filePath) ??
        null
    );
}

function normalizeFilePathFromLocations(input: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof input.file_path === 'string' && input.file_path.trim().length > 0) return null;
    const locPath = coerceSingleLocationPath(input.locations);
    if (!locPath) return null;
    return { ...input, file_path: locPath };
}

function normalizeFromAcpItems(input: Record<string, unknown>, opts: { toolNameLower: string }): Record<string, unknown> | null {
    const items = Array.isArray((input as any).items) ? ((input as any).items as unknown[]) : null;
    if (!items || items.length === 0) return null;
    const first = asRecord(items[0]);
    if (!first) return null;

    const itemPath =
        firstNonEmptyString(first.path) ??
        firstNonEmptyString(first.filePath) ??
        null;
    const oldText =
        firstNonEmptyString(first.oldText) ??
        firstNonEmptyString(first.old_string) ??
        firstNonEmptyString(first.oldString) ??
        null;
    const newText =
        firstNonEmptyString(first.newText) ??
        firstNonEmptyString(first.new_string) ??
        firstNonEmptyString(first.newString) ??
        null;

    let changed = false;
    const next: Record<string, unknown> = { ...input };

    if (itemPath && (typeof next.file_path !== 'string' || next.file_path.trim().length === 0)) {
        next.file_path = itemPath;
        changed = true;
    }

    if (opts.toolNameLower === 'write') {
        if (typeof next.content !== 'string' && newText) {
            next.content = newText;
            changed = true;
        }
    }

    if (opts.toolNameLower === 'edit') {
        if (typeof next.old_string !== 'string' && oldText) {
            next.old_string = oldText;
            changed = true;
        }
        if (typeof next.new_string !== 'string' && newText) {
            next.new_string = newText;
            changed = true;
        }
    }

    return changed ? next : null;
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
        nextInput =
            normalizeFilePathFromLocations(inputRecord) ??
            normalizeFromAcpItems(inputRecord, { toolNameLower }) ??
            inputRecord;
        const inputRecord2 = asRecord(nextInput) ?? inputRecord;
        if (toolNameLower === 'edit') {
            nextInput = normalizeEditAliases(inputRecord2) ?? inputRecord2;
        } else if (toolNameLower === 'write' || toolNameLower === 'read') {
            nextInput = normalizeFilePathAliases(inputRecord2) ?? inputRecord2;
        }
    }

    const inputChanged = nextInput !== tool.input;
    const resultChanged = parsedResult !== tool.result;
    if (!inputChanged && !resultChanged) return tool;
    return { ...tool, input: nextInput, result: parsedResult };
}
