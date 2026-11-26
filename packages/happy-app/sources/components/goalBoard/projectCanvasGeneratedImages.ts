import { collectGeneratedImagesFromMessages, type GeneratedImageEntry } from '@/hooks/generatedImagesModel';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

export type ProjectCanvasGeneratedResult = Pick<GeneratedImageEntry, 'ref' | 'name' | 'createdAt'>;

/** Derive candidates from native file events in the selected conversation. */
export function collectProjectCanvasGeneratedResults(sessionId: string, messages: readonly Message[]): ProjectCanvasGeneratedResult[] {
    if (!sessionId) return [];
    const prefix = `sessions/${sessionId}/attachments/`;
    const eligible: ToolCallMessage[] = [];
    function visit(message: Message) {
        if (message.kind !== 'tool-call') return;
        const input = message.tool.input;
        if (message.tool.name === 'file' && message.tool.state === 'completed'
            && input?.source === 'generated'
            && (input.kind === undefined || input.kind === 'image')
            && (input.mimeType === undefined || (typeof input.mimeType === 'string' && input.mimeType.startsWith('image/')))
            && typeof input.ref === 'string' && input.ref.startsWith(prefix)) {
            const fileName = input.ref.slice(prefix.length);
            if (fileName && !fileName.includes('/') && !fileName.includes('..')) eligible.push(message);
        }
        message.children.forEach(visit);
    }
    messages.forEach(visit);

    // The shared gallery accepts legacy filename and prompt heuristics. Only
    // pass explicit generated events so a user upload can never match those.
    const entries = collectGeneratedImagesFromMessages(sessionId, '', eligible).sort((a, b) => b.createdAt - a.createdAt);
    const seen = new Set<string>();
    const results: ProjectCanvasGeneratedResult[] = [];
    for (const { ref, name, createdAt } of entries) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        results.push({ ref, name, createdAt });
    }
    return results;
}
