import { describe, expect, it } from 'vitest';
import otaRuntimeVersions from '../../../ota-runtime-versions.json';
import { systemPrompt } from './systemPrompt';

describe('systemPrompt image handling', () => {
    it('tells agents to recover host-native generated images from disk before reporting failure', () => {
        expect(systemPrompt).toContain('mcp__happy__send_image');
        expect(systemPrompt).toContain('mcp__happy__send_file');
        expect(systemPrompt).toContain('~/.codex/generated_images/<task-id>/');
        expect(systemPrompt).toContain('Do not claim that an image cannot be returned');
        expect(systemPrompt).toContain('copy the generated file there and leave the original in place');
    });

    it('keeps OTA preview metadata aligned with the preview runtime source of truth', () => {
        expect(systemPrompt).toContain(`runtimeVersion: ${otaRuntimeVersions.preview}`);
    });
});
