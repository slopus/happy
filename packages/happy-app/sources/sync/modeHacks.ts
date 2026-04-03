export type HackableMode = {
    key: string;
    name: string;
    description?: string | null;
};

export function hackMode<T extends HackableMode>(mode: T): T {
    const normalizedName = mode.name.trim().toLowerCase();
    const normalizedKey = mode.key.trim().toLowerCase();
    const canonicalName = normalizedKey === 'build'
        ? 'Build'
        : normalizedKey === 'plan'
            ? 'Plan'
            : null;

    if (!canonicalName) {
        return mode;
    }

    if (
        normalizedName === normalizedKey
        || normalizedName === `${normalizedKey}, ${normalizedKey}`
        || normalizedName === `${normalizedKey}/${normalizedKey}`
    ) {
        return { ...mode, name: canonicalName };
    }

    return mode;
}

export function hackModes<T extends HackableMode>(modes: T[]): T[] {
    return modes.map(hackMode);
}
