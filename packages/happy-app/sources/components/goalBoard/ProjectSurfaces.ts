import * as React from 'react';
import { multiplyColorOpacity } from '@/utils/colorOpacity';

/** Only the desktop photo workspace opts in; text and other Goal boards stay unchanged. */
export const ProjectSurfaces = React.createContext<{ surface: string; pressed: string; selected: string } | null>(null);
export function projectSurfaces(colors: { surface: string; surfacePressed: string; surfaceSelected: string }) {
    return { surface: multiplyColorOpacity(colors.surface, 0.32), pressed: multiplyColorOpacity(colors.surfacePressed, 0.55), selected: multiplyColorOpacity(colors.surfaceSelected, 0.62) };
}
