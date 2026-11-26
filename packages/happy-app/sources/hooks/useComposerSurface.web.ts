import type { ViewStyle } from 'react-native';
import { multiplyColorOpacity } from '@/utils/colorOpacity';
import { useReducedTransparency } from './useReducedTransparency';

/** Blur the backdrop, keeping text and controls opaque. Respect accessibility changes live. */
export function useComposerSurface(background: string, border: string, enabled: boolean, dark = false): ViewStyle | undefined {
    const reducedTransparency = useReducedTransparency();
    if (!enabled) return undefined;
    const supportsBlur = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
    if (reducedTransparency || !supportsBlur) return { backgroundColor: background };
    const filter = `blur(${dark ? 16 : 12}px) saturate(${dark ? 1.08 : 1.14})`;
    return {
        backgroundColor: multiplyColorOpacity(background, 0.8),
        borderColor: border,
        backdropFilter: filter,
        WebkitBackdropFilter: filter,
    } as ViewStyle;
}
