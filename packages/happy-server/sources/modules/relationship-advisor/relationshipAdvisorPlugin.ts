import { z } from 'zod';

import { pluginRegistry } from '@/modules/plugins/pluginRegistry';

const RELATIONSHIP_ADVISOR_PLUGIN_ID = 'relationship-advisor';

const relationshipAdvisorConfigurationSchema = z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url(),
    model: z.string().min(1),
});

export interface RelationshipAdvisorConfiguration {
    apiKey: string;
    baseUrl: string;
    model: string;
}

export interface RelationshipAdvisorPluginStreamInput {
    userId: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string }>;
    imageUrls: string[];
    signal?: AbortSignal;
}

export function createRelationshipAdvisorPluginRuntime(
    plugin: { requireConfiguration: (accountId: string) => Promise<RelationshipAdvisorConfiguration> },
    providerStream: (
        input: RelationshipAdvisorPluginStreamInput,
        configuration: RelationshipAdvisorConfiguration,
    ) => AsyncIterable<{ text: string }>,
) {
    return {
        async *stream(input: RelationshipAdvisorPluginStreamInput): AsyncGenerator<{ text: string }> {
            const configuration = await plugin.requireConfiguration(input.userId);
            yield* providerStream(input, configuration);
        },
    };
}

export const relationshipAdvisorPlugin = {
    async requireImageReadPermission(accountId: string): Promise<void> {
        await pluginRegistry.requirePermission(
            accountId,
            RELATIONSHIP_ADVISOR_PLUGIN_ID,
            'paws.conversations.images.read',
        );
    },
    async requireImageWritePermission(accountId: string): Promise<void> {
        await pluginRegistry.requirePermission(
            accountId,
            RELATIONSHIP_ADVISOR_PLUGIN_ID,
            'paws.storage.images.write',
        );
    },
    async requireConfiguration(accountId: string): Promise<RelationshipAdvisorConfiguration> {
        await pluginRegistry.requirePermission(
            accountId,
            RELATIONSHIP_ADVISOR_PLUGIN_ID,
            'paws.ai.provider.invoke',
        );
        await pluginRegistry.requirePermission(accountId, RELATIONSHIP_ADVISOR_PLUGIN_ID, 'paws.secrets.use');
        return relationshipAdvisorConfigurationSchema.parse(
            await pluginRegistry.requireConfiguration(accountId, RELATIONSHIP_ADVISOR_PLUGIN_ID),
        );
    },
};
