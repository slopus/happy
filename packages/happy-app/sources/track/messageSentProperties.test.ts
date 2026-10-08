import { describe, expect, it } from 'vitest';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';
import type { Metadata } from '@/sync/storageTypes';
import { messageSentSessionProperties } from './messageSentProperties';

describe('messageSentSessionProperties', () => {
    it('reports Happy Agent version, model, provider kind and effort from the sent mode', () => {
        expect(messageSentSessionProperties(rigMetadataFixture, {
            model: 'shared-model',
            modelProviderId: 'claude',
            effort: 'max',
        })).toEqual({
            session_client: 'happy_agent',
            happy_agent_version: '0.0.30',
            model: 'shared-model',
            model_provider_kind: 'claude',
            effort: 'max',
        });
    });

    it('reports a custom provider by kind, not by its own name', () => {
        const metadata: Metadata = { ...rigMetadataFixture, models: [], providers: [], provider: undefined };
        expect(messageSentSessionProperties(metadata, { model: 'm', modelProviderId: 'my_private_proxy' }).model_provider_kind)
            .toBe('custom');
    });

    it('marks CLI sessions and leaves Happy Agent fields empty', () => {
        const metadata = { path: '/repo', host: 'mac', version: '1.2.5', flavor: 'codex' } as Metadata;
        expect(messageSentSessionProperties(metadata, { model: 'gpt-5.6-sol', effort: 'high' })).toEqual({
            session_client: 'cli',
            happy_agent_version: null,
            model: 'gpt-5.6-sol',
            model_provider_kind: null,
            effort: 'high',
        });
    });

    it('reports null model and effort when the agent default applies', () => {
        const metadata = { path: '/repo', host: 'mac', flavor: 'claude' } as Metadata;
        expect(messageSentSessionProperties(metadata, {})).toMatchObject({ model: null, effort: null });
        expect(messageSentSessionProperties(null, undefined).session_client).toBeNull();
    });
});
