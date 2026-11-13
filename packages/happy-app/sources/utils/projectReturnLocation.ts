import { mobileProjectKeys } from '@/components/goalBoard/mobileProjectNavigation';

/** Only project navigation parameters belong in the remembered rail destination. */
export function projectLocationHref(location: Record<string, unknown>): string {
    const query = new URLSearchParams();
    for (const key of mobileProjectKeys) {
        const value = location[key];
        if (typeof value === 'string' && value.length > 0 && value.length <= 8192) query.set(key, value);
    }
    const search = query.toString();
    return search ? `/projects?${search}` : '/projects';
}

export function restoreProjectLocation(value: unknown): string {
    if (typeof value !== 'string' || value.length > 65536) return '/projects';
    try {
        const url = new URL(value, 'https://paws.invalid');
        if (!value.startsWith('/projects') || url.origin !== 'https://paws.invalid' || url.pathname !== '/projects') return '/projects';
        return projectLocationHref(Object.fromEntries(url.searchParams));
    } catch { return '/projects'; }
}
