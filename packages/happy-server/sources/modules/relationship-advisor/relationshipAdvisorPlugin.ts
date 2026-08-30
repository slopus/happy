import type { PluginPermission } from '@slopus/happy-wire';
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

interface PluginCapabilityBroker {
    openRuntime: (
        accountId: string,
        pluginId: string,
        requiredPermissions: readonly PluginPermission[],
    ) => Promise<Record<string, string>>;
}

const PROVIDER_PERMISSIONS = [
    'paws.ai.provider.invoke',
    'paws.secrets.use',
] as const satisfies readonly PluginPermission[];

const IMAGE_PERMISSIONS = [
    'paws.conversations.images.read',
    'paws.storage.images.write',
] as const satisfies readonly PluginPermission[];

export function createRelationshipAdvisorPluginRuntime(capabilityBroker: PluginCapabilityBroker) {
    return {
        async openRuntime(
            accountId: string,
            options: { includeImages: boolean },
        ): Promise<RelationshipAdvisorConfiguration> {
            const requiredPermissions = options.includeImages
                ? [...PROVIDER_PERMISSIONS, ...IMAGE_PERMISSIONS]
                : [...PROVIDER_PERMISSIONS];
            return relationshipAdvisorConfigurationSchema.parse(
                await capabilityBroker.openRuntime(
                    accountId,
                    RELATIONSHIP_ADVISOR_PLUGIN_ID,
                    requiredPermissions,
                ),
            );
        },
        async openImageWriteRuntime(accountId: string): Promise<void> {
            await capabilityBroker.openRuntime(
                accountId,
                RELATIONSHIP_ADVISOR_PLUGIN_ID,
                ['paws.storage.images.write'],
            );
        },
    };
}

export const relationshipAdvisorPlugin = createRelationshipAdvisorPluginRuntime(pluginRegistry);
