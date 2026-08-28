import type { Message } from '@/sync/typesMessage';

export type BrowserStep = {
    id: string;
    createdAt: number;
    label: string;
    name: string;
    ref: string;
    width?: number;
    height?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Derive the intentionally small browser-step view model from session events.
 * Browser frames retain transport-level file semantics, but this projection
 * keeps their UI contract independent from the ordinary attachment gallery.
 */
export function getBrowserSteps(messages: Message[]): BrowserStep[] {
    return messages.flatMap((message) => {
        if (message.kind !== 'tool-call' || message.tool.name !== 'file' || !isRecord(message.tool.input)) {
            return [];
        }
        const input = message.tool.input;
        if (input.source !== 'browser_step' || !isRecord(input.browserStep)) return [];
        const ref = typeof input.ref === 'string' ? input.ref : null;
        const label = typeof input.browserStep.label === 'string' ? input.browserStep.label.trim() : '';
        if (!ref || !label) return [];
        const image = isRecord(input.image) ? input.image : null;
        return [{
            id: message.id,
            createdAt: message.createdAt,
            label,
            name: typeof input.name === 'string' ? input.name : 'browser-step.png',
            ref,
            ...(typeof image?.width === 'number' ? { width: image.width } : {}),
            ...(typeof image?.height === 'number' ? { height: image.height } : {}),
        } satisfies BrowserStep];
    }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
