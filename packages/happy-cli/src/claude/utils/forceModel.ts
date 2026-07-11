import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project-scoped model override.
 *
 * A folder carrying a `.happy-force-model` file pins the Claude model for every
 * session started in it, overriding model changes requested by a controller.
 * The marker file's first non-empty, non-`#` line is the model id and is passed
 * straight through to `claude --model`, so both aliases (`sonnet`, `opus`,
 * `haiku`) and full ids work.
 *
 * Absent marker -> returns undefined and the app's choice is used unchanged.
 */
export const FORCE_MODEL_MARKER = '.happy-force-model';

/** Read the forced model id from `<workingDirectory>/.happy-force-model`, or undefined. */
export function readForcedModel(workingDirectory: string): string | undefined {
    try {
        const markerPath = join(workingDirectory, FORCE_MODEL_MARKER);
        if (!existsSync(markerPath)) {
            return undefined;
        }
        const firstMeaningful = readFileSync(markerPath, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0 && !line.startsWith('#'));
        return firstMeaningful || undefined;
    } catch {
        // Never let a marker read break a session start.
        return undefined;
    }
}

/**
 * Resolve the effective model: the forced model always wins when present,
 * otherwise the requested (app/picker) model is used. Centralised so every
 * model-resolution site in runClaude.ts applies the same rule.
 */
export function resolveForcedModel(
    forced: string | undefined,
    requested: string | undefined,
): string | undefined {
    return forced ?? requested;
}
