import { pluginPackages } from '@paws/plugins/catalog';
import {
    type PluginConnectionTestResult,
    PluginManifestSchema,
    type PluginInstallationStatus,
    type PluginManifest,
} from '@slopus/happy-wire';

import { testRelationshipAdvisorConnection } from '@/modules/relationship-advisor/relationshipAdvisorClient';

export interface PluginDefinition {
    manifest: PluginManifest;
    normalizeConfiguration: (configuration: Record<string, string>) => Record<string, string>;
    redactConfiguration: (configuration: Record<string, string>) => Extract<PluginInstallationStatus, { installed: true }>;
    testConnection?: (configuration: Record<string, string>) => Promise<PluginConnectionTestResult>;
}

const connectionTesters: Partial<Record<string, (configuration: Record<string, string>) => Promise<PluginConnectionTestResult>>> = {
    'relationship-advisor': (configuration) => testRelationshipAdvisorConnection({
        apiKey: configuration.apiKey ?? '',
        baseUrl: configuration.baseUrl ?? '',
        model: configuration.model ?? '',
    }),
};

export const pluginDefinitions: readonly PluginDefinition[] = pluginPackages.map((pluginPackage) => {
    const manifest = PluginManifestSchema.parse(pluginPackage.manifest);
    return {
        manifest,
        normalizeConfiguration: pluginPackage.normalizeConfiguration,
        redactConfiguration(configuration) {
            return {
                installed: true,
                version: manifest.version,
                ...pluginPackage.redactConfiguration(configuration),
            };
        },
        testConnection: connectionTesters[manifest.id],
    };
});
