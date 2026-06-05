export const WORLD_CITY_NAMES = [
    'amsterdam',
    'barcelona',
    'berlin',
    'cairo',
    'chicago',
    'copenhagen',
    'dubai',
    'helsinki',
    'istanbul',
    'kyoto',
    'lisbon',
    'london',
    'marrakesh',
    'melbourne',
    'mexico-city',
    'montreal',
    'nairobi',
    'oslo',
    'prague',
    'reykjavik',
    'rio',
    'seoul',
    'singapore',
    'stockholm',
    'taipei',
    'tokyo',
    'toronto',
    'vienna',
    'warsaw',
    'zurich',
] as const

export function slugifyPathPart(value: string, fallback = 'project'): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return slug || fallback
}

export function chooseVersionedName(baseName: string, existingNames: Iterable<string>): string {
    const existing = new Set([...existingNames].map((name) => name.toLowerCase()))
    const base = baseName.toLowerCase()
    if (!existing.has(base)) return base
    for (let i = 2; ; i++) {
        const candidate = `${base}-v${i}`
        if (!existing.has(candidate)) return candidate
    }
}

export function chooseWorktreeName(
    existingNames: Iterable<string>,
    random: () => number = Math.random,
): string {
    const base = WORLD_CITY_NAMES[Math.floor(random() * WORLD_CITY_NAMES.length)] ?? WORLD_CITY_NAMES[0]
    return chooseVersionedName(base, existingNames)
}
