import { describe, expect, it } from 'vitest';

import type { CodexModel } from '../codexAppServerTypes';
import { toMetadataModels } from './modelMetadata';

function model(overrides: Partial<CodexModel> = {}): CodexModel {
    return {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: 'Latest frontier agentic coding model.',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        ...overrides,
    };
}

describe('toMetadataModels', () => {
    it('maps id/displayName/description onto the metadata option shape', () => {
        expect(toMetadataModels([model()])).toEqual([
            {
                code: 'gpt-5.6-sol',
                value: 'GPT-5.6-Sol',
                description: 'Latest frontier agentic coding model.',
            },
        ]);
    });

    it('drops hidden models', () => {
        const models = [
            model({ id: 'gpt-5.6-sol' }),
            model({ id: 'internal-preview', hidden: true }),
        ];
        expect(toMetadataModels(models).map((m) => m.code)).toEqual(['gpt-5.6-sol']);
    });

    it('never synthesises a `default` entry (the app adds its own)', () => {
        const codes = toMetadataModels([model({ isDefault: true })]).map((m) => m.code);
        expect(codes).not.toContain('default');
    });

    it('preserves backend ordering', () => {
        const models = [
            model({ id: 'gpt-5.6-sol' }),
            model({ id: 'gpt-5.6-terra', isDefault: false }),
            model({ id: 'gpt-5.5', isDefault: false }),
        ];
        expect(toMetadataModels(models).map((m) => m.code)).toEqual([
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.5',
        ]);
    });

    it('falls back to the id when displayName is empty, and nulls empty descriptions', () => {
        const [mapped] = toMetadataModels([model({ displayName: '', description: '' })]);
        expect(mapped).toEqual({
            code: 'gpt-5.6-sol',
            value: 'gpt-5.6-sol',
            description: null,
        });
    });

    it('returns an empty list when the backend reports no models', () => {
        expect(toMetadataModels([])).toEqual([]);
    });
});
