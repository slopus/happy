import * as React from 'react';
import type { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useModal } from '@/modal';
import { t } from '@/text';
import { GoalBoardButton } from './GoalBoardButton';
import type { ProjectCanvasChatPopupProps } from './ProjectCanvasChatPopup';

const slot: React.CSSProperties = {
    display: 'flex',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
};

const surface: React.CSSProperties = {
    display: 'flex',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
};

/** Expand the existing conversation surface in place so its composer and scroll
 * container retain their identity. The canvas remains interactive outside it. */
export function ProjectCanvasChatPopup({ compact = false, active = true, children }: ProjectCanvasChatPopupProps) {
    const { theme } = useUnistyles();
    const { state } = useModal();
    const [expanded, setExpanded] = React.useState(false);
    const trigger = React.useRef<View>(null);
    const handledEscape = React.useRef(false);
    const available = active && !compact;
    const floating = available && expanded;
    const label = t(floating ? 'projectCanvas.dockConversation' : 'projectCanvas.expandConversation');

    React.useEffect(() => {
        if (!available) {
            setExpanded(false);
            handledEscape.current = false;
        }
    }, [available]);

    function focusTrigger() {
        queueMicrotask(() => trigger.current?.focus());
    }

    function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        if (!floating || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || state.modals.length) return;
        const target = event.target;
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        const nearestDialog = target.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        if (nearestDialog && nearestDialog !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        handledEscape.current = true;
        setExpanded(false);
        focusTrigger();
    }

    const action = available ? <GoalBoardButton
        ref={trigger}
        variant="toolbar"
        label={label}
        tooltip={label}
        tooltipPortal
        selected={floating}
        expanded={floating}
        testID="project-canvas-chat-popup-toggle"
        onPress={() => {
            setExpanded(value => !value);
            focusTrigger();
        }}
    >
        <Ionicons name={floating ? 'contract-outline' : 'expand-outline'} size={18} color={theme.colors.textSecondary} />
    </GoalBoardButton> : null;

    return <div style={floating ? { ...slot, zIndex: 5 } : slot}>
        <div
            data-testid="project-canvas-chat-popup"
            data-expanded={floating}
            role={floating ? 'dialog' : undefined}
            aria-modal={floating ? false : undefined}
            aria-label={floating ? t('projectCanvas.conversationPopup') : undefined}
            onKeyDown={onKeyDown}
            onKeyUp={event => {
                if (event.key !== 'Escape' || !handledEscape.current) return;
                handledEscape.current = false;
                event.preventDefault();
                event.stopPropagation();
            }}
            onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) handledEscape.current = false;
            }}
            style={floating ? {
                ...surface,
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: 'min(660px, calc(100% + 176px))',
                borderRadius: 13,
                overflow: 'hidden',
                backgroundColor: theme.colors.surface,
                boxShadow: `0 12px 36px ${theme.colors.shadow.color}`,
            } : surface}
        >
            {children(action)}
        </div>
    </div>;
}
