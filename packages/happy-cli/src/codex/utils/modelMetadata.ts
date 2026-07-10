import type { Metadata } from '@/api/types';
import type { CodexModel } from '../codexAppServerTypes';

type MetadataModels = NonNullable<Metadata['models']>;

/**
 * Map Codex `model/list` entries onto the session metadata shape the mobile
 * app consumes (`{ code, value, description }`).
 *
 * The app prepends its own `default` option for Codex sessions when metadata
 * carries no `default` entry (see `getAvailableModels()` in
 * `modelModeOptions.ts`), so we deliberately do not synthesise one here —
 * `default` means "send no model override and let ~/.codex/config.toml decide".
 */
export function toMetadataModels(models: CodexModel[]): MetadataModels {
    return models
        .filter((model) => !model.hidden)
        .map((model) => ({
            code: model.id,
            value: model.displayName || model.id,
            description: model.description || null,
        }));
}
