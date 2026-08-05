import { describe, expect, it } from 'vitest';
import { systemPrompt } from './systemPrompt';

describe('systemPrompt image handling', () => {
    it('tells agents to recover host-native generated images from disk before reporting failure', () => {
        expect(systemPrompt).toContain('mcp__happy__send_image');
        expect(systemPrompt).toContain('mcp__happy__send_file');
        expect(systemPrompt).toContain('~/.codex/generated_images/<task-id>/');
        expect(systemPrompt).toContain('Do not claim that an image cannot be returned');
        expect(systemPrompt).toContain('copy the generated file there and leave the original in place');
    });
});
