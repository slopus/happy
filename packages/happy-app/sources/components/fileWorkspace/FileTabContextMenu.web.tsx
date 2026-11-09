import * as React from 'react';
import { createPortal } from 'react-dom';
import { Platform, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { tabCloseTargets, type TabCloseAction } from './tabActions';
import type { FileTabContextMenuProps } from './FileTabContextMenu';

const actions = ['current', 'others', 'all', 'left', 'right'] as const;
const labels = { current: 'closeTab', others: 'closeOtherTabs', all: 'closeAllTabs', left: 'closeTabsLeft', right: 'closeTabsRight' } as const;

export function FileTabContextMenu({ anchor, tabs, saving, onClose, onAction }: FileTabContextMenuProps) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const menuRef = React.useRef<HTMLDivElement>(null);
    const [hovered, setHovered] = React.useState<TabCloseAction | null>(null);
    React.useEffect(() => {
        if (!anchor) return;
        (menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menuRef.current)?.focus();
        const dismiss = () => onClose();
        window.addEventListener('resize', dismiss);
        window.addEventListener('blur', dismiss);
        return () => {
            window.removeEventListener('resize', dismiss);
            window.removeEventListener('blur', dismiss);
            anchor.trigger?.focus();
        };
    }, [anchor, onClose]);
    if (!anchor || Platform.OS !== 'web' || !globalThis.document) return null;
    return createPortal(<div onContextMenu={event => event.preventDefault()} onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
        style={{ position: 'fixed', inset: 0, zIndex: 10000 }}>
        <div ref={menuRef} tabIndex={-1} role="menu" aria-label={t('fileWorkspace.tabActions')} onKeyDown={event => {
            if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const index = buttons.indexOf(globalThis.document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
        }} style={{ position: 'absolute', left: Math.max(8, Math.min(anchor.x, width - 224)), top: Math.max(8, Math.min(anchor.y, height - 202)),
            width: 216, padding: 5, boxSizing: 'border-box', borderRadius: 10, border: `1px solid ${theme.colors.divider}`,
            background: theme.colors.surface, color: theme.colors.text, boxShadow: `0 8px 24px ${theme.colors.shadow.color}` }}>
            {actions.map(action => {
                const targets = tabCloseTargets(tabs, anchor.path, action);
                const disabled = targets.length === 0 || targets.some(path => saving.includes(path));
                return <button key={action} type="button" role="menuitem" disabled={disabled}
                    onPointerEnter={() => setHovered(action)} onPointerLeave={() => setHovered(null)}
                    onFocus={() => setHovered(action)} onBlur={() => setHovered(null)}
                    onClick={() => { onClose(); onAction(targets); }}
                    style={{ display: 'block', width: '100%', minHeight: 36, padding: '8px 10px', border: 0, borderRadius: 6, textAlign: 'left',
                        font: 'inherit', fontSize: 13, color: theme.colors.text, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer',
                        background: hovered === action && !disabled ? theme.colors.surfacePressed : theme.colors.surface }}>
                    {t(`fileWorkspace.${labels[action]}`)}
                </button>;
            })}
        </div>
    </div>, globalThis.document.body);
}
