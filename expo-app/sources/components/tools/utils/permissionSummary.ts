import { extractShellCommand } from './shellCommand';

type FormatPermissionRequestSummaryParams = {
    toolName: string;
    toolInput: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractFirstLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length === 0) return null;
    const first = asRecord(locations[0]);
    if (!first) return null;
    return (
        firstString(first.path) ??
        firstString(first.filePath) ??
        null
    );
}

function extractFirstItemPath(items: unknown): string | null {
    if (!Array.isArray(items) || items.length === 0) return null;
    const first = asRecord(items[0]);
    if (!first) return null;
    return (
        firstString(first.path) ??
        firstString(first.filePath) ??
        null
    );
}

function extractFilePathLike(input: unknown): string | null {
    const obj = asRecord(input);
    if (!obj) return null;

    // Common ACP-style format: { locations: [{ path }] }
    const locPath = extractFirstLocationPath(obj.locations);
    if (locPath) return locPath;

    // Gemini ACP-style nested format: { toolCall: { content: [{ path }] } }
    const toolCall = asRecord(obj.toolCall);
    const toolCallLocPath = extractFirstLocationPath(toolCall?.locations);
    if (toolCallLocPath) return toolCallLocPath;
    const contentArr = toolCall && Array.isArray((toolCall as any).content) ? ((toolCall as any).content as unknown[]) : null;
    if (contentArr && contentArr.length > 0) {
        const first = asRecord(contentArr[0]);
        const nestedPath = firstString(first?.path);
        if (nestedPath) return nestedPath;
    }

    // Gemini ACP-style array format: { input: [{ path }] }
    const inputArr = Array.isArray((obj as any).input) ? ((obj as any).input as unknown[]) : null;
    if (inputArr && inputArr.length > 0) {
        const first = asRecord(inputArr[0]);
        const nestedPath = firstString(first?.path);
        if (nestedPath) return nestedPath;
    }

    // ACP diff-style format: { items: [{ path }] }
    const itemPath = extractFirstItemPath(obj.items);
    if (itemPath) return itemPath;

    return (
        firstString(obj.filePath) ??
        firstString(obj.file_path) ??
        firstString(obj.path) ??
        firstString(obj.filepath) ??
        firstString(obj.file) ??
        null
    );
}

export function formatPermissionRequestSummary(params: FormatPermissionRequestSummaryParams): string {
    const toolName = params.toolName || 'unknown';
    const lower = toolName.toLowerCase();

    const obj = asRecord(params.toolInput);
    const permissionTitle = (() => {
        const permission = asRecord(obj?.permission);
        return (
            firstString(permission?.title) ??
            firstString(obj?.title) ??
            null
        );
    })();
    if (permissionTitle) {
        return permissionTitle;
    }

    const command = extractShellCommand(params.toolInput);
    if (command && (lower === 'bash' || lower === 'execute' || lower === 'shell')) {
        return `Run: ${command}`;
    }

    const filePath = extractFilePathLike(params.toolInput);
    if (filePath && (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'multiedit')) {
        const verb = lower === 'read' ? 'Read' : lower === 'write' ? 'Write' : 'Edit';
        return `${verb}: ${filePath}`;
    }

    const hasAnyKeys = obj ? Object.keys(obj).length > 0 : false;
    if (!hasAnyKeys) {
        return `Permission required: ${toolName} (details unavailable)`;
    }

    return `Permission required: ${toolName}`;
}
