/**
 * Parse an MCP tool result into a JSON object.
 *
 * MCP results come in multiple shapes:
 *   1. `[{type:'text', text:'...'}]`              — content array
 *   2. `{content: [{type:'text', text:'...'}]}`    — wrapped content object
 *   3. `{type:'text', text:'...'}`                 — single content block
 *   4. `string`                                    — raw JSON string
 *   5. already-parsed object                       — pass-through
 */
export function parseMcpResult(result: unknown): any {
    const text = extractMcpTextPayload(result);
    if (text !== null) {
        const trimmed = text.trim();
        if (!trimmed) return result;
        try {
            return JSON.parse(trimmed);
        } catch {
            return result;
        }
    }

    if (typeof result === 'string') {
        const trimmed = result.trim();
        if (!trimmed) return result;
        try {
            return JSON.parse(trimmed);
        } catch {
            return result;
        }
    }

    return result;
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractMcpTextPayload(value: unknown): string | null {
    if (isPlainObject(value) && Array.isArray(value.content)) {
        return extractTextFromContentArray(value.content);
    }

    if (Array.isArray(value)) {
        return extractTextFromContentArray(value);
    }

    if (isPlainObject(value) && value.type === 'text' && typeof value.text === 'string') {
        return value.text;
    }

    return null;
}

function extractTextFromContentArray(blocks: unknown[]): string | null {
    const textParts = blocks
        .map((block) => (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : null))
        .filter((value): value is string => typeof value === 'string');
    if (textParts.length === 0) {
        return null;
    }
    return textParts.join('\n');
}
