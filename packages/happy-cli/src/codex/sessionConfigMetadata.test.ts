import { describe, expect, it } from 'vitest';

import { mergeCodexSessionConfigIntoMetadata } from './sessionConfigMetadata';

describe('mergeCodexSessionConfigIntoMetadata', () => {
    it('hydrates models and effort levels from the Codex model catalog', () => {
        const next = mergeCodexSessionConfigIntoMetadata({
            path: '/tmp/project',
            host: 'machine',
        } as any, {
            currentModel: 'gpt-5.4',
            currentEffort: 'xhigh',
            models: [
                {
                    id: 'm1',
                    model: 'gpt-5.5',
                    displayName: 'GPT-5.5',
                    description: 'Primary',
                    hidden: false,
                    supportedReasoningEfforts: [
                        { reasoningEffort: 'medium', description: 'Balanced' },
                        { reasoningEffort: 'high', description: 'Deeper' },
                    ],
                    defaultReasoningEffort: 'medium',
                    isDefault: true,
                },
                {
                    id: 'm2',
                    model: 'gpt-5.4',
                    displayName: 'GPT-5.4',
                    description: 'Pinned',
                    hidden: false,
                    supportedReasoningEfforts: [
                        { reasoningEffort: 'minimal', description: 'Quickest' },
                        { reasoningEffort: 'xhigh', description: 'Deepest' },
                    ],
                    defaultReasoningEffort: 'minimal',
                    isDefault: false,
                },
            ],
        });

        expect(next.models).toEqual([
            { code: 'gpt-5.5', value: 'gpt-5.5', description: 'Primary', serviceTiers: [] },
            { code: 'gpt-5.4', value: 'gpt-5.4', description: 'Pinned', serviceTiers: [] },
        ]);
        expect(next.currentModelCode).toBe('gpt-5.4');
        expect(next.thoughtLevels).toEqual([
            { code: 'minimal', value: 'minimal', description: 'Quickest' },
            { code: 'xhigh', value: 'xhigh', description: 'Deepest' },
        ]);
        expect(next.currentThoughtLevelCode).toBe('xhigh');
    });

    it('keeps the current model visible even when it is hidden from the default picker', () => {
        const next = mergeCodexSessionConfigIntoMetadata({
            path: '/tmp/project',
            host: 'machine',
        } as any, {
            currentModel: 'gpt-hidden',
            currentEffort: null,
            models: [
                {
                    id: 'm1',
                    model: 'gpt-visible',
                    displayName: 'Visible',
                    description: 'Visible',
                    hidden: false,
                    supportedReasoningEfforts: [
                        { reasoningEffort: 'medium', description: 'Balanced' },
                    ],
                    defaultReasoningEffort: 'medium',
                    isDefault: true,
                },
                {
                    id: 'm2',
                    model: 'gpt-hidden',
                    displayName: 'Hidden',
                    description: 'Hidden',
                    hidden: true,
                    supportedReasoningEfforts: [
                        { reasoningEffort: 'high', description: 'Deeper' },
                    ],
                    defaultReasoningEffort: 'high',
                    isDefault: false,
                },
            ],
        });

        expect(next.models?.map((entry) => entry.code)).toEqual(['gpt-hidden', 'gpt-visible']);
        expect(next.currentThoughtLevelCode).toBe('high');
    });

    it('falls back to the explicit effort when the model catalog is unavailable', () => {
        const next = mergeCodexSessionConfigIntoMetadata({
            path: '/tmp/project',
            host: 'machine',
            thoughtLevels: [{ code: 'medium', value: 'medium', description: 'Old' }],
            currentThoughtLevelCode: 'medium',
        } as any, {
            currentModel: 'gpt-5.4',
            currentEffort: 'minimal',
        });

        expect(next.currentModelCode).toBe('gpt-5.4');
        expect(next.thoughtLevels).toEqual([
            { code: 'minimal', value: 'minimal', description: null },
        ]);
        expect(next.currentThoughtLevelCode).toBe('minimal');
    });
});
