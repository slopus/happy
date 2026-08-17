import {
    getAvailableModels,
    getEffortLevelsForModel,
    type EffortLevel,
    type ModeOption,
    type ModelMode,
} from '@/components/modelModeOptions';
import { resolveAgentDefaultConfig, type AgentDefaultOverrides } from '@/sync/agentDefaults';
import type { Session } from '@/sync/storageTypes';
import { supportsCodexFast } from '@/utils/codexFast';

type Translate = (key: any) => string;

export type RunningSessionTurnModes = {
    availableModels: ModelMode[];
    modelMode: ModeOption | null;
    availableEffortLevels: EffortLevel[];
    effortLevel: ModeOption | null;
    supportsFast: boolean;
};

function resolvePreferredOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): ModeOption | null {
    for (const key of preferredKeys) {
        if (!key) continue;
        const known = options.find((option) => option.key === key);
        if (known) {
            return known;
        }

        // A running CLI can report a model newer than this app's fallback
        // catalog. Preserve the first-preference code instead of skipping it
        // and incorrectly labelling the turn with a lower-priority default.
        return { key, name: key };
    }

    return options[0] ?? null;
}

/**
 * Resolves the model/effort that the next message will carry. This is shared by
 * the header dropdown and the always-visible composer selector so both surfaces
 * use the same session override -> CLI current value -> agent default order.
 */
export function resolveRunningSessionTurnModes(args: {
    session: Pick<Session, 'modelMode' | 'effortLevel' | 'metadata'>;
    agentDefaultOverrides: AgentDefaultOverrides | null | undefined;
    translate: Translate;
}): RunningSessionTurnModes {
    const { session, agentDefaultOverrides, translate } = args;
    const metadata = session.metadata;
    const flavor = metadata?.flavor;
    const defaults = resolveAgentDefaultConfig(agentDefaultOverrides, flavor);
    const availableModels = getAvailableModels(flavor, metadata, translate);
    const modelMode = resolvePreferredOption(availableModels, [
        session.modelMode,
        metadata?.currentModelCode,
        defaults.modelMode,
    ]);
    const availableEffortLevels = getEffortLevelsForModel(flavor, modelMode?.key ?? 'default', metadata);
    const effortLevel = availableEffortLevels.length > 0
        ? resolvePreferredOption(availableEffortLevels, [
            session.effortLevel,
            metadata?.currentThoughtLevelCode,
            // null means the CLI's default effort. Codex exposes that reset as
            // the explicit `default` picker option, so keep it visible.
            defaults.effortLevel ?? (availableEffortLevels.some((level) => level.key === 'default') ? 'default' : null),
        ])
        : null;

    return {
        availableModels,
        modelMode,
        availableEffortLevels,
        effortLevel,
        supportsFast: supportsCodexFast(metadata, modelMode?.key),
    };
}
