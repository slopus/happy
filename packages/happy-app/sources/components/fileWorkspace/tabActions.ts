export type TabCloseAction = 'current' | 'others' | 'all' | 'left' | 'right';

export function tabCloseTargets(tabs: readonly string[], path: string, action: TabCloseAction): string[] {
    const index = tabs.indexOf(path);
    if (index < 0) return [];
    switch (action) {
        case 'current': return [path];
        case 'others': return tabs.filter(tab => tab !== path);
        case 'all': return [...tabs];
        case 'left': return tabs.slice(0, index);
        case 'right': return tabs.slice(index + 1);
    }
}
