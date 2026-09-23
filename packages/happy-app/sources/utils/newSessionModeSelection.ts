/**
 * Null-safe option selection for the new session composer.
 *
 * A Rig machine publishes its own catalog and the machine metadata schema
 * makes `operatingModes` / `models` optional, so `getRigMachineSessionCreation`
 * legitimately returns empty option arrays. `options[index] ?? options[0]` is
 * then `undefined`, and every consumer that dereferenced it crashed the whole
 * screen. Selections are nullable here so the composer degrades to "no picker,
 * no styling" instead — the same shape HomeDock already resolves its options in.
 */
import {
    filterPermissionModesForCli,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    includeConfiguredModel,
    mapMetadataOptions,
    type AgentFlavor,
    type ModelMode,
    type PermissionMode,
} from '@/components/modelModeOptions';
import type { AgentCatalog } from '@/utils/lastAgentCatalog';

export type PermissionStyle = { color: string; icon: 'play-forward' | 'pause' };

/** The current option of an index-driven picker, or null when none is offered. */
export function resolveSelectedOption<T>(options: readonly T[], index: number): T | null {
    return options[index] ?? options[0] ?? null;
}

/**
 * Accent for permission modes that deviate from plain ask-first behaviour.
 * Returns null for the ambient `default` mode and for no selection at all.
 */
export function resolvePermissionStyle(
    permission: Pick<PermissionMode, 'key'> | null | undefined,
): PermissionStyle | null {
    switch (permission?.key) {
        case 'acceptEdits':
        case 'auto_edit':
            return { color: '#A78BFA', icon: 'play-forward' };
        case 'plan':
            return { color: '#5EABA4', icon: 'pause' };
        case 'dontAsk':
        case 'safe-yolo':
            return { color: '#FBBF24', icon: 'play-forward' };
        case 'bypassPermissions':
        case 'yolo':
            return { color: '#F87171', icon: 'play-forward' };
        case 'read-only':
            return { color: '#60A5FA', icon: 'pause' };
        default:
            return null;
    }
}

/**
 * The option lists and preselection the new-session composer offers for an
 * agent, before any session of its own exists.
 *
 * Two screens compose a new session — the home dock and the full `/new` page —
 * and they used to derive these lists independently with the same three-line
 * expression. They drifted: a fix applied to one silently left the other
 * showing a different catalog for the same agent. Both now call in here.
 *
 * Rig is resolved by its callers, which hold the machine's own catalog; these
 * helpers cover every other agent.
 */

type Translate = (key: any) => string;

/** A reported catalog is only useful when it actually has entries. */
function nonEmpty<T>(list: T[] | null | undefined): T[] | null {
    return list && list.length > 0 ? list : null;
}

/**
 * Permission modes to offer. The CLI daemon on the picked computer is what
 * parses the mode, and older CLIs drop the whole prompt on modes they do not
 * know (`auto`), so the hardcoded fallback is filtered by CLI version. A
 * catalog the agent itself reported needs no such filtering: it came from the
 * CLI that will receive it.
 */
export function resolveComposerPermissionModes({
    flavor,
    lastCatalog,
    happyCliVersion,
    translate,
}: {
    flavor: AgentFlavor;
    lastCatalog: AgentCatalog | null;
    happyCliVersion: string | null | undefined;
    translate: Translate;
}): PermissionMode[] {
    return nonEmpty(mapMetadataOptions(lastCatalog?.operatingModes))
        ?? filterPermissionModesForCli(getHardcodedPermissionModes(flavor, translate), happyCliVersion);
}

/** Models to offer, on the same reported-then-hardcoded order. */
export function resolveComposerModelModes({
    flavor,
    lastCatalog,
    configuredModelKey,
    translate,
}: {
    flavor: AgentFlavor;
    lastCatalog: AgentCatalog | null;
    configuredModelKey: string | null | undefined;
    translate: Translate;
}): ModelMode[] {
    return nonEmpty(mapMetadataOptions(lastCatalog?.models))
        ?? includeConfiguredModel(flavor, getHardcodedModelModes(flavor, translate), configuredModelKey);
}

/**
 * Which option to land on, most specific first.
 *
 * The agent's own current model sits between the two: an explicit saved pick
 * still wins, but a generic configured default must not. `default` is not a
 * key in a reported catalog, so without this the composer fell through to
 * whichever model the agent happened to list first — an arbitrary choice
 * presented as the agent's own.
 */
export function preferredModelKeys(
    savedKey: string | null | undefined,
    lastCatalog: AgentCatalog | null,
    configuredDefaultKey: string | null | undefined,
): Array<string | null | undefined> {
    return [savedKey, lastCatalog?.currentModelCode, configuredDefaultKey];
}

/** Same ordering for permission modes, with any extra tail the caller needs. */
export function preferredPermissionKeys(
    savedKey: string | null | undefined,
    lastCatalog: AgentCatalog | null,
    configuredDefaultKey: string | null | undefined,
    ...tail: Array<string | null | undefined>
): Array<string | null | undefined> {
    return [savedKey, lastCatalog?.currentOperatingModeCode, configuredDefaultKey, ...tail];
}
