import { useEffect, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isTauri } from '@/utils/isTauri';
import { useHeaderHeight } from '@/utils/responsive';

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'menuitem', 'tab', 'switch', 'checkbox', 'radio']);

const DESKTOP_CSS = `
    html, body {
        user-select: none;
        -webkit-user-select: none;
    }
    input, textarea, [contenteditable="true"], [contenteditable=""] {
        user-select: text;
        -webkit-user-select: text;
    }
    img {
        -webkit-user-drag: none;
        user-drag: none;
    }
`;

// Tauri's built-in drag.js only inspects e.target directly, so clicks on header
// children (text/icons/Pressables) silently fail. We drag when the click lands
// in the top strip (safe-area + header height) and isn't on an interactive element.
export function useTauriDrag() {
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const dragZoneRef = useRef(0);
    dragZoneRef.current = safeArea.top + headerHeight;

    useEffect(() => {
        if (!isTauri()) return;

        const style = document.createElement('style');
        style.setAttribute('data-tauri-desktop', '');
        style.textContent = DESKTOP_CSS;
        document.head.appendChild(style);

        const isInteractive = (start: HTMLElement | null): boolean => {
            let node: HTMLElement | null = start;
            while (node && node !== document.body) {
                if (node.getAttribute('data-tauri-drag-region') === 'false') return true;
                const tag = node.tagName.toLowerCase();
                if (INTERACTIVE_TAGS.has(tag)) return true;
                const role = node.getAttribute('role');
                if (role && INTERACTIVE_ROLES.has(role)) return true;
                const tabindex = node.getAttribute('tabindex');
                if (tabindex !== null && tabindex !== '-1') return true;
                node = node.parentElement;
            }
            return false;
        };

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            if (e.clientY > dragZoneRef.current) return;
            const target = e.target as HTMLElement | null;
            if (isInteractive(target)) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            window.getSelection()?.removeAllRanges();
            const cmd = e.detail === 2 ? 'internal_toggle_maximize' : 'start_dragging';
            (window as any).__TAURI_INTERNALS__.invoke('plugin:window|' + cmd)
                .catch((err: unknown) => console.error('[useTauriDrag] invoke failed:', err));
        };

        document.addEventListener('mousedown', onMouseDown, true);
        return () => {
            document.removeEventListener('mousedown', onMouseDown, true);
            style.remove();
        };
    }, []);
}
