/**
 * Keyboard shortcuts for turn-level navigation (web only).
 *
 * Uses Alt-based modifiers to avoid collisions with browser/OS defaults:
 *   Alt+↑/↓         — step one turn
 *   Alt+Shift+↑/↓   — page (skip 5 turns)
 *   Alt+Shift+End   — jump to latest
 *   Alt+.           — jump to latest (Mac laptops without End key)
 *
 * Shortcuts are suppressed when focus is inside a text input.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';

interface Handlers {
    onPrev: () => void;
    onNext: () => void;
    onPrevPage: () => void;
    onNextPage: () => void;
    onEnd: () => void;
}

function isEditableElement(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
}

export function useTurnNavigationKeyboard(handlers: Handlers) {
    useEffect(() => {
        if (Platform.OS !== 'web') return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (!e.altKey) return;
            if (isEditableElement(document.activeElement)) return;

            if (e.key === 'ArrowUp' && !e.shiftKey) {
                e.preventDefault();
                handlers.onPrev();
            } else if (e.key === 'ArrowDown' && !e.shiftKey) {
                e.preventDefault();
                handlers.onNext();
            } else if (e.key === 'ArrowUp' && e.shiftKey) {
                e.preventDefault();
                handlers.onPrevPage();
            } else if (e.key === 'ArrowDown' && e.shiftKey) {
                e.preventDefault();
                handlers.onNextPage();
            } else if ((e.key === 'End' && e.shiftKey) || e.key === '.') {
                e.preventDefault();
                handlers.onEnd();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handlers.onPrev, handlers.onNext, handlers.onPrevPage, handlers.onNextPage, handlers.onEnd]);
}
