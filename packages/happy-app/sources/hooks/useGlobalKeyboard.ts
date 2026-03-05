import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export interface GlobalKeyboardHandlers {
    onCommandPalette?: () => void;
    onNewSession?: () => void;
    onTogglePreview?: () => void;
    onScreenshot?: () => void;
    onSettings?: () => void;
    onPrevSession?: () => void;
    onNextSession?: () => void;
    onSessionByIndex?: (index: number) => void;
}

const DIGIT_CODES: Record<string, number> = {
    'Digit1': 0, 'Digit2': 1, 'Digit3': 2, 'Digit4': 3, 'Digit5': 4,
    'Digit6': 5, 'Digit7': 6, 'Digit8': 7, 'Digit9': 8,
};

export function useGlobalKeyboard(handlers: GlobalKeyboardHandlers) {
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    useEffect(() => {
        if (Platform.OS !== 'web') {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            const h = handlersRef.current;
            const target = e.target as HTMLElement;
            const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            let handled = false;

            // Ctrl+1..9 for session switching (Safari blocks Cmd+digits)
            if (e.ctrlKey && !e.metaKey && e.code in DIGIT_CODES) {
                h.onSessionByIndex?.(DIGIT_CODES[e.code]);
                handled = true;
            }

            // Cmd+Shift+Space — screenshot preview to chat
            if (e.metaKey && e.shiftKey && e.code === 'Space') {
                h.onScreenshot?.();
                handled = true;
            }

            // Cmd+key (no shift) for everything else
            if (e.metaKey && !e.shiftKey) {
                if (e.code === 'KeyK') {
                    h.onCommandPalette?.();
                    handled = true;
                } else if (e.code === 'BracketLeft') {
                    h.onPrevSession?.();
                    handled = true;
                } else if (e.code === 'BracketRight') {
                    h.onNextSession?.();
                    handled = true;
                } else if (e.code === 'KeyM' && !isInputFocused) {
                    h.onNewSession?.();
                    handled = true;
                } else if (e.code === 'KeyN') {
                    h.onTogglePreview?.();
                    handled = true;
                } else if (e.code === 'Comma') {
                    h.onSettings?.();
                    handled = true;
                }
            }

            if (handled) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });

        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
        };
    }, []);
}
