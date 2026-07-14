import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
    getGlobalShortcutId,
    getPressedShortcutModifier,
    getRecentSessionShortcutIndex,
    GlobalShortcutId,
    ShortcutModifier,
} from '@/keyboard/shortcuts';

const SHORTCUT_HINT_DELAY_MS = 240;

export interface GlobalKeyboardActions {
    commandPalette?: () => void;
    newSession?: () => void;
    settings?: () => void;
    recentSession?: (index: number) => boolean;
}

export function useGlobalKeyboard(
    actions: GlobalKeyboardActions,
    browserSafeShortcuts = false,
) {
    const [visibleModifier, setVisibleModifier] = useState<ShortcutModifier | null>(null);
    const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const actionsRef = useRef(actions);
    actionsRef.current = actions;

    const hideShortcutHints = useCallback(() => {
        if (hintTimerRef.current) {
            clearTimeout(hintTimerRef.current);
            hintTimerRef.current = null;
        }
        setVisibleModifier(null);
    }, []);

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            const modifier = getPressedShortcutModifier(e);
            if (modifier) {
                if (!e.repeat && !hintTimerRef.current) {
                    hintTimerRef.current = setTimeout(() => {
                        setVisibleModifier(modifier);
                        hintTimerRef.current = null;
                    }, SHORTCUT_HINT_DELAY_MS);
                }
                return;
            }

            const recentSessionIndex = getRecentSessionShortcutIndex(e, browserSafeShortcuts);
            if (recentSessionIndex !== null) {
                const handled = actionsRef.current.recentSession?.(recentSessionIndex) ?? false;
                if (handled) {
                    e.preventDefault();
                    e.stopPropagation();
                    hideShortcutHints();
                }
                return;
            }

            const shortcutId = getGlobalShortcutId(e, browserSafeShortcuts);
            if (!shortcutId) {
                return;
            }

            const action = actionsRef.current[shortcutId as GlobalShortcutId];
            if (action) {
                e.preventDefault();
                e.stopPropagation();
                hideShortcutHints();
                action();
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Meta' || e.key === 'Control') {
                hideShortcutHints();
            }
        };

        const handleVisibilityChange = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
                hideShortcutHints();
            }
        };

        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', hideShortcutHints);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', handleVisibilityChange);
        }

        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', hideShortcutHints);
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            }
            if (hintTimerRef.current) {
                clearTimeout(hintTimerRef.current);
                hintTimerRef.current = null;
            }
        };
    }, [browserSafeShortcuts, hideShortcutHints]);

    return visibleModifier;
}
