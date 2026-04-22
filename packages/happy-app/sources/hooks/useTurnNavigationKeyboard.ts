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
import { getTurnNavigationAction } from './turnNavigationKeyboard';

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
            if (isEditableElement(document.activeElement)) return;
            const action = getTurnNavigationAction(e);
            if (!action) return;

            e.preventDefault();

            if (action === 'prev') {
                handlers.onPrev();
            } else if (action === 'next') {
                handlers.onNext();
            } else if (action === 'prevPage') {
                handlers.onPrevPage();
            } else if (action === 'nextPage') {
                handlers.onNextPage();
            } else if (action === 'end') {
                handlers.onEnd();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handlers.onPrev, handlers.onNext, handlers.onPrevPage, handlers.onNextPage, handlers.onEnd]);
}
