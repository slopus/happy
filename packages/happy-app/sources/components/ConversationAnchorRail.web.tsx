// Adapted from T3 Code's TimelineMinimap (MIT). See T3-CODE-LICENSE.txt.
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { multiplyColorOpacity } from '@/utils/colorOpacity';
import type { ConversationAnchorRailProps } from './ConversationAnchorRail';
import { conversationAnchorPreview } from './conversationAnchorPreview.web';

export function ConversationAnchorRail(props: ConversationAnchorRailProps) {
    const { theme } = useUnistyles();
    const [size, setSize] = React.useState({ width: 0, height: 0, finePointer: false });
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const [currentId, setCurrentId] = React.useState<string | null>(null);
    // The loaded history window is not the whole conversation. A long running
    // turn can leave only one (or no) prompt in the current page.
    const available = size.width >= 520 && size.height >= 180 && size.finePointer
        && (props.anchors.length > 0 || props.hasMoreOlder === true);
    const data = React.useRef(props);
    data.current = props;

    React.useEffect(() => {
        const viewport = props.viewportRef.current as unknown as HTMLElement | null;
        const scroll = props.listRef.current?.getScrollableNode?.() as HTMLElement | undefined;
        if (!viewport?.getBoundingClientRect || !scroll?.querySelectorAll) return;
        const pointer = window.matchMedia('(hover: hover) and (pointer: fine)');
        let frame: number | undefined;
        const update = () => {
            frame = undefined;
            const bounds = viewport.getBoundingClientRect();
            setSize(previous => previous.width === bounds.width && previous.height === bounds.height
                && previous.finePointer === pointer.matches ? previous
                : { width: bounds.width, height: bounds.height, finePointer: pointer.matches });
            const { rows, anchors, inverted } = data.current;
            const rowIndexes = new Map(rows.map((row, index) => [row.renderKey, index]));
            const anchorIndexes = new Map(rows.map((row, index) => [row.id, index]));
            const top = scroll.getBoundingClientRect().top;
            const readingLine = top + Math.min(80, scroll.clientHeight / 4);
            let visibleIndex: number | undefined;
            let nearest = Infinity;
            for (const row of scroll.querySelectorAll<HTMLElement>('[data-transcript-key]')) {
                const rect = row.getBoundingClientRect();
                if (rect.bottom <= top || rect.top >= top + scroll.clientHeight) continue;
                const distance = rect.top <= readingLine && rect.bottom > readingLine ? 0 : Math.abs(rect.top - readingLine);
                const index = rowIndexes.get(row.dataset.transcriptKey!);
                if (index !== undefined && distance < nearest) { nearest = distance; visibleIndex = index; }
            }
            if (visibleIndex === undefined) return;
            let current = anchors[0]?.id ?? null;
            for (const anchor of anchors) {
                const index = anchorIndexes.get(anchor.id);
                if (index !== undefined && (inverted ? index >= visibleIndex : index <= visibleIndex)) current = anchor.id;
            }
            setCurrentId(current);
        };
        const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
        const resize = new ResizeObserver(schedule);
        resize.observe(viewport);
        if (scroll.firstElementChild) resize.observe(scroll.firstElementChild);
        const mutation = new MutationObserver(schedule);
        mutation.observe(scroll, { childList: true, subtree: true });
        scroll.addEventListener('scroll', schedule, { passive: true });
        pointer.addEventListener('change', schedule);
        update();
        return () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            resize.disconnect(); mutation.disconnect();
            scroll.removeEventListener('scroll', schedule);
            pointer.removeEventListener('change', schedule);
        };
    }, [props.viewportRef, props.listRef, props.rows, props.anchors]);

    React.useEffect(() => { props.onAvailabilityChange(available); }, [available, props.onAvailabilityChange]);
    const activeIndex = props.anchors.findIndex(anchor => anchor.id === activeId);
    const selectedIndex = activeIndex >= 0 ? activeIndex : null;
    const setActiveIndex = (index: number | null) => setActiveId(index === null ? null : props.anchors[index]?.id ?? null);
    const selected = selectedIndex === null ? null : props.anchors[selectedIndex];
    const preview = React.useMemo(() => selected ? conversationAnchorPreview(selected, props.items) : null, [selected, props.items]);
    const previewId = React.useId();
    if (!available) return null;

    const height = Math.max(8, Math.min((props.anchors.length - 1) * 8, size.height - 160));
    const top = (size.height - height) / 2;
    const position = (index: number) => props.anchors.length <= 1 ? height / 2 : index / (props.anchors.length - 1) * height;
    const fromPointer = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (props.anchors.length <= 1) return 0;
        const bounds = event.currentTarget.getBoundingClientRect();
        return Math.round(Math.max(0, Math.min(1, (event.clientY - bounds.top - 4) / height)) * (props.anchors.length - 1));
    };
    const select = (index: number) => { props.onSelect(props.anchors[index]); setActiveIndex(null); };
    const buttonStyle: React.CSSProperties = {
        border: 0, padding: 0, background: 'transparent', color: theme.colors.textSecondary,
        cursor: 'pointer', position: 'absolute', left: 8, width: 32,
    };
    return <div data-testid="conversation-anchor-rail" role="navigation" aria-label={t('session.anchorsTitle')}
        style={{ position: 'absolute', inset: '0 auto 0 0', width: 40, pointerEvents: 'none', zIndex: 30,
            ...Typography.default(), color: theme.colors.text, '--anchor-focus': theme.colors.textLink } as React.CSSProperties}>
        <style>{`
            .paws-anchor-track:focus-visible, .paws-anchor-list:focus-visible { outline: 2px solid var(--anchor-focus); outline-offset: 3px; border-radius: 4px; }
            .paws-anchor-track:focus:not(:focus-visible), .paws-anchor-list:focus:not(:focus-visible) { outline: none; }
            .paws-anchor-list { opacity: 0; transition: opacity 150ms; }
            [data-testid="conversation-anchor-rail"]:hover .paws-anchor-list, .paws-anchor-list:focus-visible { opacity: 1; }
            .paws-anchor-strip { transition: transform 150ms, opacity 150ms; }
            @media (prefers-reduced-motion: reduce) { .paws-anchor-strip, .paws-anchor-list { transition: none; } }
        `}</style>
        <button className="paws-anchor-list" type="button" aria-label={t('session.anchorsTitle')}
            title={props.hasMoreOlder ? t('session.anchorsLoadedSubtitle', { count: props.anchors.length }) : t('session.anchorsTitle')}
            style={{ ...buttonStyle, top: props.anchors.length ? top - 30 : size.height / 2 - 12,
                height: 24, pointerEvents: 'auto', ...(!props.anchors.length ? { opacity: 1 } : {}) }} onClick={props.onOpenList}>
            <Octicons name="list-unordered" size={14} color={theme.colors.textSecondary} />
        </button>
        {props.anchors.length > 0 && <button className="paws-anchor-track" type="button" data-testid="conversation-anchor-track"
            aria-label={selected ? `${t('session.anchorsButton')}: ${selected.ordinal}. ${preview?.prompt}` : t('session.anchorsTitle')}
            aria-describedby={preview ? previewId : undefined}
            style={{ ...buttonStyle, top: top - 4, height: height + 8, pointerEvents: 'auto', touchAction: 'pan-y' }}
            onMouseDown={event => event.preventDefault()}
            onMouseMove={event => { if (event.buttons === 0) setActiveIndex(fromPointer(event)); }}
            onMouseLeave={event => { if (document.activeElement !== event.currentTarget) setActiveIndex(null); }}
            onFocus={() => setActiveIndex(props.anchors.findIndex(anchor => anchor.id === currentId) >= 0
                ? props.anchors.findIndex(anchor => anchor.id === currentId) : 0)}
            onBlur={() => setActiveIndex(null)}
            onClick={event => select(event.detail === 0 ? selectedIndex ?? 0 : fromPointer(event))}
            onKeyDown={event => {
                const base = selectedIndex ?? Math.max(0, props.anchors.findIndex(anchor => anchor.id === currentId));
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    setActiveIndex(event.key === 'Home' ? 0 : event.key === 'End' ? props.anchors.length - 1
                        : Math.max(0, Math.min(props.anchors.length - 1, base + (event.key === 'ArrowDown' ? 1 : -1))));
                } else if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); setActiveIndex(null);
                }
            }}>
            {props.anchors.map((anchor, index) => {
                const distance = selectedIndex === null ? Infinity : Math.abs(index - selectedIndex);
                const scale = distance === 0 ? 1 : distance === 1 ? 2 / 3 : distance === 2 ? 5 / 12 : 1 / 3;
                const current = anchor.id === currentId;
                return <span key={anchor.id} className="paws-anchor-strip" aria-hidden="true"
                    data-anchor-id={anchor.id} data-current={current} style={{
                        pointerEvents: 'none', position: 'absolute', left: 4, top: 4 + position(index), width: 24, height: 2,
                        borderRadius: 1, transformOrigin: 'left center', transform: `translateY(-50%) scaleX(${scale})`,
                        background: current || distance === 0 ? theme.colors.text : theme.colors.textSecondary,
                        opacity: current ? 0.72 : distance === 0 ? 0.6 : 0.28,
                    }} />;
            })}
        </button>}
        {preview && selectedIndex !== null && <div id={previewId} role="tooltip" data-testid="conversation-anchor-preview"
            style={{ position: 'absolute', left: 44, top: Math.max(64, Math.min(size.height - 64, top + position(selectedIndex))),
                transform: 'translateY(-50%)', width: Math.min(320, size.width - 64), boxSizing: 'border-box',
                padding: 12, borderRadius: 12, border: `1px solid ${theme.colors.divider}`, background: theme.colors.surface,
                boxShadow: `0 8px 24px ${multiplyColorOpacity(theme.colors.shadow.color, theme.colors.shadow.opacity)}`,
                pointerEvents: 'none', textAlign: 'left', fontSize: 14, lineHeight: '20px' }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview.prompt}</div>
            {preview.reply && <div style={{ marginTop: 4, color: theme.colors.textSecondary, display: '-webkit-box',
                WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>{preview.reply}</div>}
        </div>}
    </div>;
}
