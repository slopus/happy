import * as React from 'react';
import { createPortal } from 'react-dom';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { fileAnnotationLabel, fileAnnotationSourceId, formatAnnotatedMessage, type MessageAnnotation, type AnnotationSelection } from './annotationDraft';
import { annotationDraftStore, useMessageAnnotations } from './annotationRuntime';
import { annotationRange, readAnnotationRange, readAnnotationSelection } from './annotationSelection';
import type { AnnotationSourceProps, AnnotationComposerProps, FileAnnotationSourceProps } from './MessageAnnotations';
import { useFileWorkspace } from '../fileWorkspace/context';
import { documentDirty } from '../fileWorkspace/controller';
import { fileAnnotationUi, useFileAnnotationUi } from './fileAnnotationUi';
export { useMessageAnnotations };

type Anchor = { left: number; top: number; bottom: number; right?: number };
type MovingAnchor = { getAnchor?: () => Anchor | null; getBounds?: () => DOMRect | undefined };
type EditRequest = { sessionId: string; id: string; anchor: Anchor; focus: HTMLElement | null; sequence: number; selection?: AnnotationSelection } & MovingAnchor;
let editRequest: EditRequest | null = null;
let sequence = 0;
const editListeners = new Set<() => void>();
const subscribeEditor = (listener: () => void) => { editListeners.add(listener); return () => { editListeners.delete(listener); }; };
const getEditor = () => editRequest;
function requestEdit(sessionId: string, id: string, anchor: Anchor, focus: HTMLElement | null, moving: MovingAnchor = {}) {
    editRequest = { sessionId, id, anchor, focus, sequence: ++sequence, ...moving };
    editListeners.forEach(listener => listener());
}
function requestCreate(sessionId: string, selection: AnnotationSelection, anchor: Anchor, focus: HTMLElement | null, moving: MovingAnchor) {
    editRequest = { sessionId, id: 'new-file-annotation', selection, anchor, focus, sequence: ++sequence, ...moving };
    editListeners.forEach(listener => listener());
}
function editingItem(sessionId: string, items: readonly MessageAnnotation[], request: EditRequest | null) {
    if (request?.sessionId !== sessionId) return undefined;
    return request.selection ? { ...request.selection, id: request.id, revision: 0, comment: '' } : items.find(a => a.id === request.id);
}

function closeEditor() {
    const focus = editRequest?.focus;
    editRequest = null;
    editListeners.forEach(listener => listener());
    if (focus?.isConnected) focus.focus({ preventScroll: true });
}

function Icon({ name }: { name: 'edit' | 'trash' | 'close' | 'comment' | 'check' | 'scope' }) {
    const paths = { edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', close: 'm6 6 12 12M6 18 18 6', comment: 'M21 11a8 8 0 0 1-8 8H6l-4 3V7a5 5 0 0 1 5-5h9a5 5 0 0 1 5 5v4ZM7 7h9M7 11h6', check: 'm5 12 4 4L20 5', scope: 'M3 7h6m4 0h8M3 17h10m4 0h4M13 4v6M9 14v6' };
    return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
function useAnnotationStyles() {
    const { theme } = useUnistyles();
    const c = theme.colors;
    const button: React.CSSProperties = { border: 0, borderRadius: 8, padding: '7px 9px', font: 'inherit', fontSize: 13, cursor: 'pointer', outlineColor: c.accent, color: c.text, background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0 };
    return { theme, c, button };
}
function SmallButton({ children, style, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    const { c, button } = useAnnotationStyles();
    const [hover, setHover] = React.useState(false);
    return <button {...props} type={props.type ?? 'button'} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ ...button, ...(hover ? { background: c.surfacePressed } : {}), ...style }}>{children}</button>;
}
function FloatingPanel({ anchor, children, label, onClose, testId = 'annotation-editor', width = 460, maxHeight = 'calc(100dvh - 24px)', ignoreOutside, getAnchor, getBounds, variant = 'panel' }: {
    anchor: Anchor; children: React.ReactNode; label: string; onClose: () => void; testId?: string; width?: number;
    maxHeight?: string; ignoreOutside?: HTMLElement | null; variant?: 'panel' | 'capsule' | 'bubble' | 'preview';
} & MovingAnchor) {
    const { c } = useAnnotationStyles();
    const ref = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState({ left: 12, top: 12 });
    React.useLayoutEffect(() => {
        let frame: number | undefined;
        const layout = () => {
            if (!ref.current) return;
            const live = getAnchor?.();
            if (getAnchor && !live) { onClose(); return; }
            const target = live ?? anchor;
            const bounds = getBounds?.();
            const minLeft = Math.max(12, (bounds?.left ?? 0) + 12);
            const minTop = Math.max(12, (bounds?.top ?? 0) + 12);
            const right = Math.min(window.innerWidth - 12, (bounds?.right ?? window.innerWidth) - 12);
            const bottom = Math.min(window.innerHeight - 12, (bounds?.bottom ?? window.innerHeight) - 12);
            ref.current.style.maxWidth = Math.max(0, Math.min(width, right - minLeft)) + 'px';
            if (getBounds) ref.current.style.maxHeight = Math.max(0, bottom - minTop) + 'px';
            const rect = ref.current.getBoundingClientRect();
            const beside = variant === 'bubble';
            const above = variant === 'capsule';
            const left = beside
                ? ((target.right ?? target.left) + rect.width + 12 <= right ? (target.right ?? target.left) + 10 : target.left - rect.width - 10)
                : target.left + (above ? 30 : 0);
            const preferredTop = beside ? target.top - 2
                : above ? (target.top - rect.height - 8 >= minTop ? target.top - rect.height - 8 : target.bottom + 8)
                : getBounds ? (target.bottom + rect.height + 10 <= bottom ? target.bottom + 10 : target.top - rect.height - 10)
                : (target.top - rect.height - (variant === 'preview' ? 6 : 10) >= minTop ? target.top - rect.height - (variant === 'preview' ? 6 : 10) : target.bottom + (variant === 'preview' ? 6 : 10));
            setPosition({ left: Math.max(minLeft, Math.min(left, right - rect.width)), top: Math.max(minTop, Math.min(preferredTop, bottom - rect.height)) });
        };
        const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; layout(); }); };
        const observer = new ResizeObserver(schedule);
        observer.observe(ref.current!);
        if (getAnchor) window.addEventListener('scroll', schedule, true);
        window.addEventListener('resize', schedule);
        layout();
        return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
    }, [anchor, getAnchor, getBounds, onClose, variant, width]);
    React.useEffect(() => {
        const pointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !ignoreOutside?.contains(event.target as Node)) onClose(); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
        document.addEventListener('pointerdown', pointer);
        document.addEventListener('keydown', key, true);
        return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key, true); };
    }, [onClose, ignoreOutside]);
    return createPortal(<div ref={ref} role="dialog" aria-label={label} data-testid={testId} className={variant === 'bubble' ? 'paws-annotation-bubble' : variant === 'capsule' ? 'paws-annotation-capsule' : variant === 'preview' ? 'paws-annotation-preview' : undefined} data-annotation-surface={variant} style={{ position: 'fixed', zIndex: 10000, ...position, boxSizing: 'border-box', width: variant === 'bubble' ? 'max-content' : `min(${width}px, calc(100vw - 24px))`, maxHeight, overflowY: 'auto', padding: variant === 'capsule' ? '6px 7px 6px 12px' : variant === 'bubble' ? '11px 18px' : variant === 'preview' ? 0 : 16, borderRadius: variant === 'capsule' ? 999 : variant === 'bubble' ? 26 : 14, color: c.text, background: c.surface, border: `1px solid ${variant === 'panel' ? c.divider : `color-mix(in srgb, ${c.text} 9%, ${c.surface})`}`, boxShadow: variant === 'preview' ? `0 6px 16px ${c.shadow.color}, 0 1px 3px ${c.shadow.color}` : variant === 'panel' ? `0 8px 36px ${c.shadow.color}` : `0 2px 8px color-mix(in srgb, ${c.shadow.color} 16%, transparent), 0 1px 2px color-mix(in srgb, ${c.shadow.color} 5%, transparent)`, fontFamily: 'inherit', fontSize: 14 }}>{children}</div>, document.body);
}
function LegacyCommentEditor({ sessionId, item, request, number, onClose }: { sessionId: string; item: MessageAnnotation; request: EditRequest; number: number; onClose: () => void }) {
    const { c, button } = useAnnotationStyles();
    const [comment, setComment] = React.useState(item.comment);
    const [error, setError] = React.useState('');
    const input = React.useRef<HTMLTextAreaElement>(null);
    const labelId = React.useId();
    React.useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
    const action = (fn: () => void) => { try { fn(); onClose(); } catch { setError(t('messageAnnotations.saveError')); } };
    const save = () => action(() => {
        if (request.selection) {
            const created = annotationDraftStore.add(sessionId, request.selection, comment);
            fileAnnotationUi.update(sessionId, { activeId: created.id });
        } else annotationDraftStore.update(sessionId, item.id, comment);
    });
    const quote = <blockquote data-testid="annotation-editor-quote" style={{ margin: '10px 0 14px', paddingInlineStart: 10, borderInlineStart: `2px solid ${c.accent}`, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.7 }}>{item.quote}</blockquote>;
    return <FloatingPanel anchor={request.anchor} getAnchor={request.getAnchor} getBounds={request.getBounds} width={item.file ? 336 : 460} label={t('messageAnnotations.edit')} onClose={onClose}>
        <form onSubmit={event => { event.preventDefault(); save(); }} onKeyDown={event => { event.stopPropagation(); if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); save(); } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: c.textSecondary, fontSize: 12 }}>
                <Icon name="comment" /><span style={{ flex: 1 }}>{request.selection ? t('messageAnnotations.addFile') : t('messageAnnotations.number', { number })}</span>
                <SmallButton aria-label={t('common.cancel')} onClick={onClose}><Icon name="close" /></SmallButton>
            </div>
            {item.file ? <>
                <div data-testid="annotation-editor-file" title={item.file.path} style={{ fontSize: 11, color: c.textSecondary, marginTop: 4 }}>{fileAnnotationLabel(item.file)}</div>
                <details style={{ marginTop: 10, color: c.textSecondary, fontSize: 12 }}><summary style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.quote}>{item.quote.slice(0, 34)}{item.quote.length > 34 ? '…' : ''}</summary>{quote}</details>
            </> : quote}
            {!item.file && <label id={labelId} style={{ fontSize: 12, color: c.textSecondary }}>{t('messageAnnotations.comment')}</label>}
            <textarea ref={input} data-testid="annotation-comment-input" aria-label={item.file ? t('messageAnnotations.yourComment') : undefined} aria-labelledby={item.file ? undefined : labelId} value={comment} onChange={event => setComment(event.target.value)} placeholder={t(item.file ? 'messageAnnotations.filePlaceholder' : 'messageAnnotations.placeholder')} style={{ width: '100%', minHeight: item.file ? 104 : 88, maxHeight: 220, boxSizing: 'border-box', resize: 'vertical', border: 0, borderRadius: 6, outlineColor: c.accent, background: c.surface, color: c.text, font: 'inherit', lineHeight: 1.7, padding: '12px 2px', marginTop: 8 }} />
            {error && <p role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error}</p>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${c.divider}`, paddingTop: 10 }}>
                {!request.selection && <SmallButton aria-label={t('messageAnnotations.remove')} onClick={() => action(() => annotationDraftStore.remove(sessionId, item.id))} style={{ color: c.textSecondary }}><Icon name="trash" /></SmallButton>}
                <span style={{ flex: 1 }} /><SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
                <button type="submit" data-testid="annotation-save" style={{ ...button, background: c.button.primary.background, color: c.button.primary.tint }}>{t('common.save')}</button>
            </div>
        </form>
    </FloatingPanel>;
}

function CommentEditor(props: { sessionId: string; item: MessageAnnotation; request: EditRequest; number: number; onClose: () => void }) {
    return props.item.file ? <FileCommentCapsule {...props} /> : <LegacyCommentEditor {...props} />;
}
function FileCommentCapsule({ sessionId, item, request, onClose }: { sessionId: string; item: MessageAnnotation; request: EditRequest; onClose: () => void }) {
    const { c } = useAnnotationStyles();
    const [comment, setComment] = React.useState(item.comment);
    const [error, setError] = React.useState(false);
    const input = React.useRef<HTMLInputElement>(null);
    const composing = React.useRef(false);
    React.useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
    const save = () => {
        if (!comment.trim() || composing.current) return;
        try {
            let id = item.id;
            if (request.selection) id = annotationDraftStore.add(sessionId, request.selection, comment.trim()).id;
            else annotationDraftStore.update(sessionId, id, comment.trim());
            fileAnnotationUi.update(sessionId, { activeId: id });
            onClose();
        } catch { setError(true); }
    };
    return <FloatingPanel anchor={request.anchor} getAnchor={request.getAnchor} getBounds={request.getBounds} width={368} variant="capsule" label={t('messageAnnotations.edit')} onClose={onClose}>
        <style>{`.paws-annotation-pill-input::placeholder { color: ${c.textSecondary}; opacity: .6; } .paws-annotation-save { transition: transform 160ms ease; } .paws-annotation-save:not(:disabled):hover { transform: scale(1.08); } @media (prefers-reduced-motion: reduce) { .paws-annotation-save { transition: none; } }`}</style>
        <form data-annotation-quote={item.quote} onSubmit={event => { event.preventDefault(); save(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); if (!event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) save(); } }} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 34 }}>
            <span title={item.quote} style={{ color: c.textSecondary, display: 'flex', opacity: .7 }}><Icon name="scope" /></span>
            <input ref={input} type="text" data-testid="annotation-comment-input" className="paws-annotation-pill-input" aria-label={t('messageAnnotations.yourComment')} aria-invalid={error || undefined} title={error ? t('messageAnnotations.saveError') : undefined} value={comment} onChange={event => { setComment(event.target.value); setError(false); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={t('messageAnnotations.addComment')} style={{ flex: 1, minWidth: 0, width: '100%', border: 0, outline: 0, padding: '4px 0', color: c.text, background: 'transparent', font: 'inherit', fontSize: 14, lineHeight: '24px' }} />
            <button type="submit" data-testid="annotation-save" className="paws-annotation-save" aria-label={t('common.save')} disabled={!comment.trim()} style={{ width: 34, height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: '50%', background: error ? c.textDestructive : c.text, color: c.surface, opacity: comment.trim() ? .9 : .35, cursor: comment.trim() ? 'pointer' : 'default' }}><Icon name="check" /></button>
        </form>
    </FloatingPanel>;
}

function FileAnnotationSummary({ sessionId, items, workspace }: { sessionId: string; items: readonly MessageAnnotation[]; workspace: ReturnType<typeof useFileWorkspace> }) {
    const { c, button } = useAnnotationStyles();
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState('');
    const ui = useFileAnnotationUi(sessionId);
    const locationError = items.some(item => item.id === ui.unlocatedId) ? t('messageAnnotations.unlocated') : '';
    const chip = React.useRef<HTMLButtonElement>(null);
    const getAnchor = React.useCallback(() => chip.current?.getBoundingClientRect() ?? null, []);
    const close = React.useCallback(() => setOpen(false), []);
    const navigate = async (item: MessageAnnotation, edit: boolean, anchor: DOMRect) => {
        setOpen(false); setError('');
        try {
            if (workspace) {
                await workspace.openReference(item.file!.path);
                const current = workspace.controller.getSnapshot().documents[item.file!.path];
                if (!current || current.phase !== 'ready' || current.hash !== item.file!.hash || documentDirty(current)) {
                    fileAnnotationUi.update(sessionId, { activeId: undefined, focus: undefined, unlocatedId: item.id });
                    return;
                }
            }
            if (edit) requestEdit(sessionId, item.id, anchor, chip.current);
            fileAnnotationUi.focus(sessionId, item.id, edit, item.file!.path);
        } catch { setError(t('messageAnnotations.unlocated')); }
    };
    return <span style={{ display: 'inline-flex', marginInlineEnd: 8 }}>
        <style>{`.paws-annotation-chip { transition: transform 160ms ease, box-shadow 160ms ease; transform-origin: left center; } .paws-annotation-chip:hover { transform: scale(1.035); } .paws-annotation-preview { transition: transform 160ms ease; transform-origin: left bottom; } .paws-annotation-preview:hover { transform: scale(1.02); } .paws-annotation-preview-row { transition: background-color 160ms ease; } .paws-annotation-preview-row:hover { background: ${c.surfacePressed}; } @media (prefers-reduced-motion: reduce) { .paws-annotation-chip,.paws-annotation-preview,.paws-annotation-preview-row { transition: none; transform: none !important; } }`}</style>
        <button ref={chip} type="button" data-testid="annotation-file-summary" className="paws-annotation-chip" aria-expanded={open} onMouseEnter={() => setOpen(true)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} style={{ ...button, border: `1px solid color-mix(in srgb, ${c.text} 9%, ${c.surface})`, borderRadius: 999, padding: '6px 10px', background: c.surface, fontSize: 12, gap: 6 }}><Icon name="comment" />{t('messageAnnotations.count', { count: items.length })}</button>
        {open && chip.current && <FloatingPanel anchor={chip.current.getBoundingClientRect()} getAnchor={getAnchor} label={t('messageAnnotations.list')} testId="file-annotation-preview" variant="preview" width={400} maxHeight="min(420px, 50dvh)" onClose={close} ignoreOutside={chip.current}>
            {items.map((item, index) => <div key={item.id} data-testid="file-annotation-preview-row" className="paws-annotation-preview-row" role="button" tabIndex={0} onClick={event => { void navigate(item, false, event.currentTarget.getBoundingClientRect()); }} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void navigate(item, false, event.currentTarget.getBoundingClientRect()); } }} style={{ padding: '10px 16px', cursor: 'pointer', borderTop: index ? `1px solid ${c.divider}` : undefined }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', height: 24, color: `oklch(from ${c.textSecondary} l 0 h)`, fontSize: 14, lineHeight: '20px' }}>
                    <span aria-hidden="true" title={item.quote} style={{ display: 'block', width: 28, height: 22, flexShrink: 0, overflow: 'hidden', border: `1px solid ${c.divider}`, borderRadius: 5, padding: 3, boxSizing: 'border-box', fontSize: 3, lineHeight: '4px', whiteSpace: 'pre-wrap', color: c.text }}>{item.quote}</span>
                    <span title={item.file!.path}>{t('messageAnnotations.selectedText')}</span><span style={{ flex: 1 }} />
                    <SmallButton data-testid="annotation-edit" aria-label={t('messageAnnotations.editNumber', { number: index + 1 })} onClick={event => { event.stopPropagation(); void navigate(item, true, event.currentTarget.getBoundingClientRect()); }} style={{ padding: 4, color: 'inherit' }}><Icon name="edit" /></SmallButton>
                    <SmallButton data-testid="annotation-remove" aria-label={t('messageAnnotations.removeNumber', { number: index + 1 })} onClick={event => { event.stopPropagation(); try { annotationDraftStore.remove(sessionId, item.id); } catch { setError(t('messageAnnotations.saveError')); } }} style={{ padding: 4, color: 'inherit' }}><Icon name="trash" /></SmallButton>
                </div>
                <div data-testid="annotation-saved-comment" style={{ marginTop: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14, fontWeight: 500, lineHeight: '23px', color: c.text }}>{item.comment || t('messageAnnotations.fileReview')}</div>
            </div>)}
        </FloatingPanel>}
        {(error || locationError) && <span role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error || locationError}</span>}
    </span>;
}

export function AnnotationComposer({ sessionId }: AnnotationComposerProps) {
    const allItems = useMessageAnnotations(sessionId);
    const items = React.useMemo(() => allItems.filter(a => !a.file), [allItems]);
    const fileItems = allItems.filter(a => a.file);
    const workspace = useFileWorkspace();
    const request = React.useSyncExternalStore(subscribeEditor, getEditor, () => null);
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState('');
    const { c } = useAnnotationStyles();
    const ref = React.useRef<HTMLDivElement>(null);
    const trigger = React.useRef<HTMLButtonElement>(null);
    const listId = React.useId();
    const closeList = React.useCallback(() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }, []);
    React.useEffect(() => { setOpen(false); setError(''); return () => { if (editRequest?.sessionId === sessionId) closeEditor(); }; }, [sessionId]);
    const editedItem = request?.sessionId === sessionId ? items.find(a => a.id === request.id) : undefined;
    const close = React.useCallback(() => { closeEditor(); }, []);
    return <div ref={ref} data-testid="annotation-composer" style={{ position: 'relative', minWidth: 0, padding: allItems.length ? '12px 14px 0' : 0, color: c.text }}>
        {fileItems.length > 0 && <FileAnnotationSummary sessionId={sessionId} items={fileItems} workspace={workspace} />}
        {items.length > 0 && <button ref={trigger} type="button" data-testid="annotation-summary" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(value => !value)} style={{ border: `1px solid ${c.divider}`, borderRadius: 10, padding: '6px 10px', background: c.surface, color: c.text, cursor: 'pointer', display: 'inline-flex', gap: 7, alignItems: 'center', font: 'inherit', fontSize: 12 }}><Icon name="comment" />{t('messageAnnotations.count', { count: items.length })}<span aria-hidden="true">{open ? '⌄' : '⌃'}</span></button>}
        {open && items.length > 0 && trigger.current && <FloatingPanel anchor={trigger.current.getBoundingClientRect()} label={t('messageAnnotations.list')} testId="annotation-list" width={640} maxHeight="min(440px, 50dvh)" onClose={closeList} ignoreOutside={trigger.current}><div id={listId}>
            {items.map((item, index) => <div key={item.id} data-testid={`annotation-row-${item.id}`} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', gap: 8, padding: '14px 0', borderTop: index ? `1px solid ${c.divider}` : undefined, fontSize: 13 }}>
                <span style={{ color: c.textSecondary }}>{index + 1}.</span><div style={{ minWidth: 0 }}>{item.file && <div data-testid="annotation-source-file" title={item.file.path} style={{ color: c.textSecondary, fontSize: 12, overflowWrap: 'anywhere', marginBottom: 6 }}>{fileAnnotationLabel(item.file)}</div>}<div style={{ color: c.textSecondary, fontSize: 11 }}>{t('messageAnnotations.selectedText')}</div><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65, margin: '3px 0 10px' }}>{item.quote}</div><div style={{ color: c.textSecondary, fontSize: 11 }}>{item.comment ? t('messageAnnotations.yourComment') : t('messageAnnotations.noComment')}</div>{item.comment && <div data-testid="annotation-saved-comment" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65, marginTop: 3 }}>{item.comment}</div>}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><SmallButton data-testid="annotation-edit" aria-label={t('messageAnnotations.editNumber', { number: index + 1 })} onClick={event => { requestEdit(sessionId, item.id, event.currentTarget.getBoundingClientRect(), trigger.current); setOpen(false); }}><Icon name="edit" /></SmallButton><SmallButton data-testid="annotation-remove" aria-label={t('messageAnnotations.removeNumber', { number: index + 1 })} onClick={() => { try { annotationDraftStore.remove(sessionId, item.id); } catch { setError(t('messageAnnotations.saveError')); } }}><Icon name="trash" /></SmallButton></div>
            </div>)}
        </div></FloatingPanel>}
        {error && <div role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error}</div>}
        {editedItem && request && <CommentEditor key={request.sequence} sessionId={sessionId} item={editedItem} request={request} number={items.indexOf(editedItem) + 1} onClose={close} />}
    </div>;
}

export function FileAnnotationControls({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
    const ui = useFileAnnotationUi(sessionId);
    const items = useMessageAnnotations(sessionId).filter(a => a.file);
    const { c } = useAnnotationStyles();
    React.useEffect(() => { if (!enabled) fileAnnotationUi.update(sessionId, { marking: false }); }, [enabled, sessionId, ui.marking]);
    return <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <SmallButton data-testid="file-annotation-mode" disabled={!enabled} aria-pressed={ui.marking} title={enabled ? t('messageAnnotations.markHint') : t('messageAnnotations.saveBeforeMarking')} onClick={() => fileAnnotationUi.update(sessionId, { marking: !ui.marking })} style={{ borderRadius: 999, padding: '7px 12px', opacity: enabled ? 1 : 0.45, background: ui.marking ? c.surfaceSelected : 'transparent', color: ui.marking ? c.accent : c.textSecondary }}><Icon name="scope" />{t('messageAnnotations.mark')}</SmallButton>

    </div>;
}
export function FileAnnotationHint({ sessionId }: { sessionId: string }) {
    const ui = useFileAnnotationUi(sessionId);
    const { c } = useAnnotationStyles();
    React.useEffect(() => {
        if (!ui.marking) return;
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !editRequest) fileAnnotationUi.update(sessionId, { marking: false }); };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [sessionId, ui.marking]);
    if (!ui.marking) return null;
    return null;
}
export function FileAnnotationPanel({ sessionId }: { sessionId: string; compact?: boolean; showPreview?: (path: string) => void }) {
    const items = useMessageAnnotations(sessionId);
    const request = React.useSyncExternalStore(subscribeEditor, getEditor, () => null);
    const edited = editingItem(sessionId, items, request);
    const close = React.useCallback(() => closeEditor(), []);
    return edited?.file && request ? <CommentEditor key={request.sequence} sessionId={sessionId} item={edited} request={request} number={items.indexOf(edited) + 1} onClose={close} /> : null;
}

export function AnnotatableMessage({ sessionId, messageId, enabled, children }: AnnotationSourceProps) {
    if (!enabled || !sessionId) return <>{children}</>;
    return <AnnotationSource sessionId={sessionId} messageId={messageId}>{children}</AnnotationSource>;
}
export function AnnotatableFile({ sessionId, file, children }: FileAnnotationSourceProps) {
    if (!sessionId || !file) return <>{children}</>;
    return <AnnotationSource key={sessionId + fileAnnotationSourceId(file)} sessionId={sessionId} messageId={fileAnnotationSourceId(file)} file={file}>{children}</AnnotationSource>;
}
function AnnotationSource({ sessionId, messageId, file, children }: Omit<AnnotationSourceProps, 'enabled'> & { sessionId: string; file?: FileAnnotationSourceProps['file'] }) {
    const items = useMessageAnnotations(sessionId);
    const annotations = React.useMemo(() => items.filter(a => a.messageId === messageId), [items, messageId]);
    const ui = useFileAnnotationUi(sessionId);
    const marking = !!file && ui.marking;
    const root = React.useRef<HTMLDivElement>(null);
    const source = React.useRef<HTMLDivElement>(null);
    const uniqueId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const highlightName = `paws-annotation-${uniqueId}`;
    const { c, button } = useAnnotationStyles();
    const [selection, setSelection] = React.useState<ReturnType<typeof readAnnotationSelection>>(null);
    const [error, setError] = React.useState('');
    type Box = { left: number; top: number; width: number; height: number };
    const [hover, setHover] = React.useState<Box | null>(null);
    const [activeBox, setActiveBox] = React.useState<Box | null>(null);
    const [badges, setBadges] = React.useState<Array<{ id: string; top: number; left: number; number: number }>>([]);
    const request = React.useSyncExternalStore(subscribeEditor, getEditor, () => null);
    const pending = request?.sessionId === sessionId && request.selection?.messageId === messageId ? request.selection : null;
    const box = (rect: DOMRect): Box => {
        const base = root.current!.getBoundingClientRect();
        return { left: rect.left - base.left - 5, top: rect.top - base.top - 5, width: rect.width + 10, height: rect.height + 10 };
    };
    React.useLayoutEffect(() => {
        if (!annotations.length && !pending) { setBadges([]); setActiveBox(null); return; }
        let frame: number | undefined;
        const layout = () => {
            if (!source.current || !root.current) return;
            const ranges: Range[] = [];
            const positions: typeof badges = [];
            let focused: Box | null = null;
            for (const a of annotations) {
                const range = annotationRange(source.current, a);
                if (!range) continue;
                if (!file || ui.activeId === a.id) ranges.push(range);
                const rect = range.getBoundingClientRect();
                const last = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()).at(-1) ?? rect : rect;
                const base = root.current.getBoundingClientRect();
                positions.push({ id: a.id, number: items.indexOf(a) + 1, top: (file ? last.top - 12 : rect.bottom - 24) - base.top, left: file ? Math.max(0, Math.min(last.right - base.left - 6, base.width - 30)) : 0 });
            }
            if (pending) {
                const range = annotationRange(source.current, pending);
                if (range) { if (!file) ranges.push(range); focused = box(range.getBoundingClientRect()); }
            }
            const api = CSS as unknown as { highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void } };
            const Constructor = (globalThis as unknown as { Highlight?: new(...ranges: Range[]) => unknown }).Highlight;
            if (api.highlights && Constructor) api.highlights.set(highlightName, new Constructor(...ranges));
            positions.sort((a, b) => a.top - b.top);
            for (let i = 1; i < positions.length; i++) positions[i].top = Math.max(positions[i].top, positions[i - 1].top + (file ? 32 : 26));
            setBadges(positions); setActiveBox(focused);
        };
        const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; layout(); }); };
        const observer = new ResizeObserver(schedule);
        const mutations = new MutationObserver(schedule);
        observer.observe(source.current!); mutations.observe(source.current!, { subtree: true, childList: true, characterData: true });
        window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); layout();
        return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); if (frame !== undefined) cancelAnimationFrame(frame); (CSS as unknown as { highlights?: { delete: (name: string) => void } }).highlights?.delete(highlightName); };
    }, [annotations, items, highlightName, pending, ui.activeId, file?.path]);
    React.useEffect(() => {
        if (!file || !ui.focus || !source.current) return;
        const item = items.find(a => a.id === ui.focus!.id);
        if (item?.file?.path !== file.path) return;
        const range = item.messageId === messageId ? annotationRange(source.current, item) : null;
        if (!range) { fileAnnotationUi.update(sessionId, { unlocatedId: item.id, focus: undefined }); return; }
        if (ui.unlocatedId === item.id) fileAnnotationUi.update(sessionId, { unlocatedId: undefined });
        if (ui.focus.edit) requestEdit(sessionId, item.id, range.getBoundingClientRect(), root.current, moving(item));
        const target = range.startContainer.parentElement;
        target?.scrollIntoView({ block: 'center', behavior: 'auto' });
        Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-annotation-id]') ?? []).find(node => node.dataset.annotationId === item.id)?.focus({ preventScroll: true });
        fileAnnotationUi.update(sessionId, { focus: undefined });
    }, [file?.path, messageId, ui.focus, items, sessionId]);
    React.useEffect(() => {
        setHover(null);
        if (!marking || !source.current) return;
        const nodes = Array.from(source.current.querySelectorAll<HTMLElement>('[data-annotation-block]'));
        for (const node of nodes) { node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', t('messageAnnotations.mark') + ': ' + (node.textContent ?? '').slice(0, 50)); }
        const clear = () => setHover(null);
        window.addEventListener('scroll', clear, true);
        return () => { window.removeEventListener('scroll', clear, true); for (const node of nodes) { node.removeAttribute('tabindex'); node.removeAttribute('role'); node.removeAttribute('aria-label'); } };
    }, [marking]);
    React.useEffect(() => {
        if (!selection) return;
        const dismiss = () => setSelection(null);
        const collapse = () => { if (window.getSelection()?.isCollapsed) dismiss(); };
        const reposition = () => {
            const next = source.current && readAnnotationSelection(source.current, messageId, window.getSelection());
            setSelection(next && next.rect.bottom > 0 && next.rect.top < window.innerHeight ? next : null);
        };
        const pointer = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-testid=annotation-add]')) dismiss(); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
        document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key); document.addEventListener('selectionchange', collapse);
        window.addEventListener('scroll', reposition, true); window.addEventListener('resize', dismiss);
        return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); document.removeEventListener('selectionchange', collapse); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', dismiss); };
    }, [selection, messageId]);
    React.useEffect(() => () => {
        if (!file || editRequest?.sessionId !== sessionId) return;
        const current = editingItem(sessionId, annotationDraftStore.getSnapshot(sessionId), editRequest);
        if (current?.messageId === messageId) closeEditor();
    }, [sessionId, messageId, !!file]);
    React.useEffect(() => {
        if (!file || !ui.activeId) return;
        const dismiss = (event: PointerEvent) => {
            if (!(event.target instanceof Element) || !event.target.closest('[data-testid="annotation-badge"],[data-testid="file-annotation-bubble"],[data-testid="annotation-editor"],[data-testid="file-annotation-preview"],[data-testid="annotation-file-summary"]')) fileAnnotationUi.update(sessionId, { activeId: undefined });
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [file?.path, sessionId, ui.activeId]);
    const moving = (data: AnnotationSelection, target?: HTMLElement): MovingAnchor => ({
        getAnchor: () => target?.isConnected ? target.getBoundingClientRect() : source.current ? annotationRange(source.current, data)?.getBoundingClientRect() ?? null : null,
        getBounds: () => source.current?.closest<HTMLElement>('[data-testid="workspace-reading-pane"]')?.getBoundingClientRect(),
    });
    const open = (value: NonNullable<typeof selection>, target?: HTMLElement) => {
        try {
            const { rect, ...selected } = value;
            const data = { ...selected, ...(file ? { file } : {}) };
            if (file) {
                const existing = annotationDraftStore.getSnapshot(sessionId).find(a => a.messageId === messageId && a.start === data.start && a.end === data.end && a.anchorText === data.anchorText);
                if (existing) { requestEdit(sessionId, existing.id, rect, root.current, moving(data, target)); fileAnnotationUi.update(sessionId, { activeId: existing.id }); }
                else requestCreate(sessionId, data, rect, root.current, moving(data, target));
            } else {
                const item = annotationDraftStore.add(sessionId, data);
                requestEdit(sessionId, item.id, rect, root.current);
            }
            setSelection(null); setHover(null); window.getSelection()?.removeAllRanges();
        } catch { setError(t('messageAnnotations.saveError')); }
    };
    const pointTarget = (eventTarget: EventTarget | null) => {
        if (!(eventTarget instanceof Element)) return null;
        const element = eventTarget.closest<HTMLElement>('[data-annotation-block],p,h1,h2,h3,h4,li');
        return element && source.current?.contains(element) ? element : null;
    };
    const pick = (target: HTMLElement) => {
        if (editRequest || !source.current) return;
        const range = document.createRange(); range.selectNodeContents(target);
        const data = readAnnotationRange(source.current, messageId, range);
        if (data) open(data, target);
    };
    const capture = () => { if (!editRequest && source.current) setSelection(readAnnotationSelection(source.current, messageId, window.getSelection())); };
    const outline: React.CSSProperties = { position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box', border: `${file ? 1.5 : 1}px solid ${c.accent}`, borderRadius: file ? 2 : 6, zIndex: 1 };
    return <div ref={root} tabIndex={-1} style={{ position: 'relative', width: '100%', minWidth: 0, outline: 'none' }} data-testid={`annotation-source-${messageId}`}>
        <style>{`::highlight(${highlightName}) { background-color: ${file ? `color-mix(in srgb, ${c.accent} 34%, transparent)` : c.surfaceSelected}; color: ${c.text}; } .paws-annotation-pin,.paws-annotation-bubble,.paws-annotation-capsule { transition: transform 160ms ease; } .paws-annotation-pin:hover { transform: scale(1.12); } .paws-annotation-bubble:hover { transform: scale(1.035); } .paws-annotation-capsule:hover { transform: scale(1.02); } @media (prefers-reduced-motion: reduce) { .paws-annotation-pin,.paws-annotation-bubble,.paws-annotation-capsule { transition: none; transform: none !important; } }`}</style>
        {file && activeBox && <span aria-hidden="true" data-testid="file-annotation-pending-pin" style={{ position: 'absolute', left: activeBox.left + 24, top: activeBox.top - 28, width: 28, height: 28, borderRadius: '50% 50% 50% 5px', background: c.accent, zIndex: 2 }} />}
        {file && activeBox && <div data-testid="file-annotation-active-outline" style={{ ...outline, ...activeBox, opacity: 0.65 }} />}
        {marking && hover && !request && <div data-testid="file-annotation-hover" style={{ ...outline, ...hover }} />}
        <div ref={source} onMouseUp={capture} onKeyUp={capture}
            onPointerMove={event => { if (marking && !editRequest) { const target = pointTarget(event.target); setHover(target ? box(target.getBoundingClientRect()) : null); } }}
            onPointerLeave={() => setHover(null)}
            onClickCapture={event => { if (!marking) return; event.preventDefault(); event.stopPropagation(); if (window.getSelection()?.toString().trim()) return; const target = pointTarget(event.target); if (target) pick(target); }}
            onKeyDown={event => { if (marking && (event.key === 'Enter' || event.key === ' ')) { const target = pointTarget(event.target); if (target) { event.preventDefault(); event.stopPropagation(); pick(target); } } }}
            style={{ paddingInlineStart: 0, paddingInlineEnd: !file && annotations.length ? 30 : 0, cursor: marking ? 'crosshair' : undefined }} data-testid="annotation-source-content">{children}</div>
        {badges.map(badge => <button key={badge.id} type="button" data-testid="annotation-badge" data-annotation-id={badge.id} className={file ? 'paws-annotation-pin' : undefined} aria-label={t('messageAnnotations.editNumber', { number: badge.number })}
            onMouseEnter={() => { if (file && !editRequest) fileAnnotationUi.update(sessionId, { activeId: badge.id }); }}
            onFocus={() => { if (file && !editRequest) fileAnnotationUi.update(sessionId, { activeId: badge.id }); }}
            onClick={event => {
                if (file) { fileAnnotationUi.update(sessionId, { activeId: badge.id }); return; }
                requestEdit(sessionId, badge.id, event.currentTarget.getBoundingClientRect(), root.current);
            }} style={{ ...button, position: 'absolute', ...(file ? { left: badge.left } : { insetInlineEnd: 0 }), top: badge.top, borderRadius: file ? '50% 50% 50% 6px' : 24, padding: 0, width: file ? 30 : 24, height: file ? 30 : 24, background: file ? c.accent : c.button.primary.background, color: c.button.primary.tint, fontSize: 12, zIndex: 3 }}>{badge.number}</button>)}
        {file && !request && annotations.filter(a => a.id === ui.activeId).map(item => {
            const position = badges.find(a => a.id === item.id);
            if (!position || !root.current) return null;
            const base = root.current.getBoundingClientRect();
            const anchor = { left: base.left + position.left, right: base.left + position.left + 30, top: base.top + position.top, bottom: base.top + position.top + 30 };
            const pin = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-annotation-id]') ?? []).find(node => node.dataset.annotationId === item.id);
            const edit = () => { const range = source.current && annotationRange(source.current, item); if (range) requestEdit(sessionId, item.id, range.getBoundingClientRect(), root.current, moving(item)); };
            return <FloatingPanel key={item.id} anchor={anchor} getAnchor={() => pin()?.getBoundingClientRect() ?? anchor} getBounds={() => source.current?.closest<HTMLElement>('[data-testid="workspace-reading-pane"]')?.getBoundingClientRect()} width={330} variant="bubble" label={t('messageAnnotations.yourComment')} testId="file-annotation-bubble" onClose={() => fileAnnotationUi.update(sessionId, { activeId: undefined })} ignoreOutside={pin()}>
                <div role="button" tabIndex={0} onClick={edit} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } }} style={{ cursor: 'pointer', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6, fontSize: 14, fontWeight: 500 }}>{item.comment || t('messageAnnotations.fileReview')}</div>
            </FloatingPanel>;
        })}
        {selection && !request && createPortal(<button type="button" data-testid="annotation-add" onMouseDown={event => event.preventDefault()} onClick={() => open(selection)} style={{ ...button, position: 'fixed', zIndex: 9999, left: Math.max(12, Math.min(selection.rect.left, window.innerWidth - 170)), top: Math.max(12, Math.min(selection.rect.top - 44, window.innerHeight - 48)), padding: '9px 12px', background: c.surface, border: `1px solid ${c.divider}`, boxShadow: `0 4px 20px ${c.shadow.color}` }}><Icon name="comment" />{t(file ? 'messageAnnotations.addFile' : 'messageAnnotations.add')}</button>, document.body)}
        {error && <div role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error}</div>}
    </div>;
}

export function restoreAnnotatedMessage(sessionId: string, annotations: readonly MessageAnnotation[]) {
    annotationDraftStore.restore(sessionId, annotations);
}
export function prepareAnnotatedMessage(sessionId: string, text: string) {
    const snapshot = annotationDraftStore.getSnapshot(sessionId);
    const labels = { intro: t('messageAnnotations.promptIntro'), annotation: t('messageAnnotations.annotation'), quote: t('messageAnnotations.selectedText'), comment: t('messageAnnotations.yourComment'), explain: t('messageAnnotations.explain'), additional: t('messageAnnotations.additional'), fileInstructions: t('messageAnnotations.fileInstructions'), fileReview: t('messageAnnotations.fileReview') };
    return {
        text: formatAnnotatedMessage(text, snapshot, labels),
        displayText: formatAnnotatedMessage(text, snapshot, labels, false),
        annotations: snapshot,
        commit: () => annotationDraftStore.clearSubmitted(sessionId, snapshot),
    };
}
