import { describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { collectProjectCanvasGeneratedResults } from './projectCanvasGeneratedImages';

function file(ref: string, input: Record<string, unknown>, createdAt = 1): ToolCallMessage {
    return {
        id: ref + createdAt, kind: 'tool-call', createdAt, localId: null, children: [],
        tool: { name: 'file', state: 'completed', input: { ref, ...input }, createdAt, startedAt: null, completedAt: createdAt, description: null },
    };
}

describe('project canvas generated image sources', () => {
    it('excludes native user uploads and unmarked filenames even when the gallery heuristic recognizes them', () => {
        const messages = [
            file('sessions/current/attachments/own.png', { name: 'gpt-image-2.png', source: 'user', image: {}, prompt: 'reference' }),
            file('sessions/current/attachments/legacy.png', { name: 'gpt-image-2.png', image: {}, batchId: 'legacy' }),
            file('sessions/current/attachments/browser.png', { name: 'step.png', source: 'browser_step' }),
            file('sessions/current/attachments/voice.m4a', { name: 'voice.m4a', source: 'generated', kind: 'audio' }),
            file('sessions/current/attachments/movie.mp4', { name: 'movie.mp4', source: 'generated', mimeType: 'video/mp4' }),
            file('sessions/current/attachments/output.png', { name: 'result.png', source: 'generated' }),
        ];
        expect(collectProjectCanvasGeneratedResults('current', messages)).toEqual([
            { ref: 'sessions/current/attachments/output.png', name: 'result.png', createdAt: 1 },
        ]);
    });

    it('keeps unique results from the selected session, with newer and nested outputs available', () => {
        const output = 'sessions/second/attachments/output.png';
        const nested = 'sessions/second/attachments/nested.png';
        const excluded = 'sessions/first/attachments/output.png';
        const traversal = 'sessions/second/attachments/../output.png';
        const messages: Message[] = [
            file(excluded, { name: 'wrong session', source: 'generated' }, 7),
            file(traversal, { name: 'wrong reference', source: 'generated' }, 6),
            file(output, { name: 'new title', source: 'generated', kind: 'image' }, 5),
            { ...file('', {}, 4), children: [file(nested, { name: 'child', source: 'generated' }, 3)] },
            file(output, { name: 'old title', source: 'generated' }, 2),
        ];
        expect(collectProjectCanvasGeneratedResults('second', messages)).toEqual([
            { ref: output, name: 'new title', createdAt: 5 },
            { ref: nested, name: 'child', createdAt: 3 },
        ]);
        expect(collectProjectCanvasGeneratedResults('first', messages)).toEqual([{ ref: excluded, name: 'wrong session', createdAt: 7 }]);
        expect(collectProjectCanvasGeneratedResults('', messages)).toEqual([]);
    });
});
