export const RESTORE_DESKTOP_BREAKPOINT = 900;

export type RestoreLayout = 'compact' | 'desktop';

export function getRestoreLayout(viewportWidth: number): RestoreLayout {
    return viewportWidth >= RESTORE_DESKTOP_BREAKPOINT ? 'desktop' : 'compact';
}
