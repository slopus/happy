/**
 * One-word permission vocabulary shared by every harness.
 *
 * The composer shows the current permission mode as a chip beside the model and
 * effort chips, so a mode has room for a single word and nothing more. Harnesses
 * we ship catalogs for are named with these words directly; a harness that
 * publishes its own catalog (Happy's agent, or any machine metadata) keeps its
 * own wording and is shortened to its first word — "Workspace write" reads as
 * "Workspace", "Read only" as "Read".
 */

/**
 * Pick order, lowest first. Auto leads because a harness that reviews its own
 * calls is the everyday choice; Edits sits with it as the narrower version of
 * the same idea. Default trails because "ask me about every tool" is what you
 * fall back to when none of the others fit. Yolo/Full sits just above it: the
 * escape hatch and the safety net are both ends of the same scale.
 *
 * Auto is not a word we hand out. Only a harness that publishes its own catalog
 * can claim it, and today that is Happy's agent.
 */
const PERMISSION_RANKS: Record<string, number> = {
    auto: 10,
    edits: 15,
    plan: 20,
    workspace: 30,
    read: 40,
    yolo: 50,
    full: 50,
    default: 100,
};

/** Words we do not know sort above `default` so they stay easy to reach. */
const UNRANKED = 90;

function firstWord(name: string): string {
    return name.trim().split(/\s+/)[0] ?? '';
}

/** The single word shown on the composer chip for a permission mode. */
export function getPermissionModeShortLabel(mode: { name: string } | null | undefined): string | null {
    if (!mode) return null;
    return firstWord(mode.name) || null;
}

/**
 * The text shown on a row of the permission menu. The iOS menu draws option
 * labels alone, with no room for a separate description, so a description has
 * to be folded into the label to appear at all.
 *
 * Only a one-word name gets one. Our own names are single words that cannot
 * stand alone — Auto and Default say nothing by themselves — while a harness
 * publishing its own catalog names modes in full ("Workspace write", "Read
 * only"), where appending a sentence only pushed the row onto a second line
 * and truncated it mid-word.
 */
export function getPermissionModeMenuLabel(
    mode: { name: string; description?: string | null },
): string {
    const description = mode.description?.trim();
    const isOneWord = mode.name.trim().split(/\s+/).length === 1;
    return description && isOneWord ? `${mode.name} · ${description}` : mode.name;
}

export function getPermissionModeRank(mode: { name: string }): number {
    return PERMISSION_RANKS[firstWord(mode.name).toLowerCase()] ?? UNRANKED;
}

/**
 * Orders a catalog a harness published for itself. Modes we have no word for
 * keep the order the harness sent them in, since it knows its own list better
 * than a rank table does.
 */
export function sortPermissionModes<T extends { name: string }>(modes: T[]): T[] {
    return modes
        .map((mode, index) => ({ mode, index, rank: getPermissionModeRank(mode) }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map((entry) => entry.mode);
}
