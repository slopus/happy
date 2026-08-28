import { pluginPackages } from '@paws/plugins/catalog';
import {
    PluginManifestSchema,
    type PluginInstallationStatus,
    type PluginManifest,
} from '@slopus/happy-wire';

export interface PluginDefinition {
    manifest: PluginManifest;
    normalizeConfiguration: (configuration: Record<string, string>) => Record<string, string>;
    redactConfiguration: (configuration: Record<string, string>) => Extract<PluginInstallationStatus, { installed: true }>;
}

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
    };
});
