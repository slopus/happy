import { describe, expect, it, vi } from 'vitest';

const registryMock = vi.hoisted(() => ({
    requirePermission: vi.fn(async () => undefined),
    requireConfiguration: vi.fn(async () => ({
        apiKey: 'server-stored-secret',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-chat',
    })),
}));

vi.mock('@/modules/plugins/pluginRegistry', () => ({
    pluginRegistry: registryMock,
}));

import {
    createRelationshipAdvisorPluginRuntime,
    relationshipAdvisorPlugin,
} from '@/modules/relationship-advisor/relationshipAdvisorPlugin';

describe('createRelationshipAdvisorPluginRuntime', () => {
    it('brokers provider and secret configuration separately from image reads', async () => {
        await relationshipAdvisorPlugin.requireConfiguration('user-4');
        await relationshipAdvisorPlugin.requireImageReadPermission('user-4');
        await relationshipAdvisorPlugin.requireImageWritePermission('user-4');

        expect(registryMock.requirePermission.mock.calls).toEqual([
            ['user-4', 'relationship-advisor', 'paws.ai.provider.invoke'],
            ['user-4', 'relationship-advisor', 'paws.secrets.use'],
            ['user-4', 'relationship-advisor', 'paws.conversations.images.read'],
            ['user-4', 'relationship-advisor', 'paws.storage.images.write'],
        ]);
    });

    it('decrypts the user configuration only when starting the provider stream', async () => {
        const configuration = {
            apiKey: 'server-stored-secret',
            baseUrl: 'https://api.example.com/v1',
            model: 'example-chat',
        };
        const requireConfiguration = vi.fn(async () => configuration);
        const providerStream = vi.fn(async function* () {
            yield { text: 'hello' };
        });
        const runtime = createRelationshipAdvisorPluginRuntime(
            { requireConfiguration },
            providerStream,
        );
        const input = {
            userId: 'user-4',
            messages: [{ role: 'user' as const, text: 'hi' }],
            imageUrls: [],
        };

        const deltas = [];
        for await (const delta of runtime.stream(input)) deltas.push(delta);

        expect(deltas).toEqual([{ text: 'hello' }]);
        expect(requireConfiguration).toHaveBeenCalledWith('user-4');
        expect(providerStream).toHaveBeenCalledWith(input, configuration);
    });
});
