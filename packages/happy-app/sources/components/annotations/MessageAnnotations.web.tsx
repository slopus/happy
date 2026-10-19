import * as React from 'react';
import { createPortal } from 'react-dom';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { formatAnnotatedMessage, type MessageAnnotation } from './annotationDraft';
import { annotationDraftStore, useMessageAnnotations } from './annotationRuntime';
import { annotationRange, readAnnotationSelection } from './annotationSelection';
import type { AnnotationSourceProps, AnnotationComposerProps } from './MessageAnnotations';
export { useMessageAnnotations };

type Anchor = { left: number; top: number; bottom: number };
type EditRequest = { sessionId: string; id: string; anchor: Anchor; focus: HTMLElement | null; sequence: number };
let editRequest: EditRequest | null = null;
let sequence = 0;
const editListeners = new Set<() => void>();
const subscribeEditor = (listener: () => void) => { editListeners.add(listener); return () => { editListeners.delete(listener); }; };
const getEditor = () => editRequest;
function requestEdit(sessionId: string, id: string, anchor: Anchor, focus: HTMLElement | null) {
    editRequest = { sessionId, id, anchor, focus, sequence: ++sequence };
    editListeners.forEach(listener => listener());
}
function closeEditor() {
    const focus = editRequest?.focus;
    editRequest = null;
    editListeners.forEach(listener => listener());
    if (focus?.isConnected) focus.focus({ preventScroll: true });
}

function Icon({ name }: { name: 'edit' | 'trash' | 'close' | 'comment' | 'check' }) {
    const paths = { edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', close: 'm6 6 12 12M6 18 18 6', comment: 'M21 11a8 8 0 0 1-8 8H6l-4 3V7a5 5 0 0 1 5-5h9a5 5 0 0 1 5 5v4ZM7 7h9M7 11h6', check: 'm5 12 4 4L20 5' };
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
function FloatingPanel({ anchor, children, label, onClose, testId = 'annotation-editor', width = 460, maxHeight = 'calc(100dvh - 24px)', ignoreOutside }: { anchor: Anchor; children: React.ReactNode; label: string; onClose: () => void; testId?: string; width?: number; maxHeight?: string; ignoreOutside?: HTMLElement | null }) {
    const { c } = useAnnotationStyles();
    const ref = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState({ left: 12, top: 12 });
    React.useLayoutEffect(() => {
        const rect = ref.current!.getBoundingClientRect();
        setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - rect.width - 12)), top: Math.max(12, Math.min(anchor.top - rect.height - 10 >= 12 ? anchor.top - rect.height - 10 : anchor.bottom + 10, window.innerHeight - rect.height - 12)) });
    }, [anchor]);
    React.useEffect(() => {
        const pointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !ignoreOutside?.contains(event.target as Node)) onClose(); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
        document.addEventListener('pointerdown', pointer);
        document.addEventListener('keydown', key, true);
        window.addEventListener('resize', onClose);
        return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', onClose); };
    }, [onClose, ignoreOutside]);
    return createPortal(<div ref={ref} role="dialog" aria-label={label} data-testid={testId} style={{ position: 'fixed', zIndex: 10000, ...position, boxSizing: 'border-box', width: `min(${width}px, calc(100vw - 24px))`, maxHeight, overflowY: 'auto', padding: 16, borderRadius: 16, color: c.text, background: c.surface, border: `1px solid ${c.divider}`, boxShadow: `0 8px 36px ${c.shadow.color}`, fontFamily: 'inherit', fontSize: 14 }}>{children}</div>, document.body);
}
function CommentEditor({ sessionId, item, request, number, onClose }: { sessionId: string; item: MessageAnnotation; request: EditRequest; number: number; onClose: () => void }) {
    const { c, button } = useAnnotationStyles();
    const [comment, setComment] = React.useState(item.comment);
    const [error, setError] = React.useState('');
    const input = React.useRef<HTMLTextAreaElement>(null);
    const labelId = React.useId();
    React.useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
    const action = (fn: () => void) => { try { fn(); onClose(); } catch { setError(t('messageAnnotations.saveError')); } };
    return <FloatingPanel anchor={request.anchor} label={t('messageAnnotations.edit')} onClose={onClose}>
        <form onSubmit={event => { event.preventDefault(); action(() => annotationDraftStore.update(sessionId, item.id, comment)); }} onKeyDown={event => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: c.textSecondary, fontSize: 12 }}><span>{t('messageAnnotations.number', { number })}</span><SmallButton aria-label={t('common.cancel')} onClick={onClose}><Icon name="close" /></SmallButton></div>
            <blockquote data-testid="annotation-editor-quote" style={{ margin: '10px 0 16px', paddingInlineStart: 12, borderInlineStart: `2px solid ${c.accent}`, maxHeight: 130, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>{item.quote}</blockquote>
            <label id={labelId} style={{ fontSize: 12, color: c.textSecondary }}>{t('messageAnnotations.comment')}</label>
            <textarea ref={input} data-testid="annotation-comment-input" aria-labelledby={labelId} value={comment} onChange={event => setComment(event.target.value)} placeholder={t('messageAnnotations.placeholder')} style={{ width: '100%', minHeight: 88, maxHeight: 220, boxSizing: 'border-box', resize: 'vertical', border: 0, borderRadius: 6, outlineColor: c.accent, background: c.surface, color: c.text, font: 'inherit', lineHeight: 1.7, padding: '10px 2px', marginTop: 4 }} />
            {error && <p role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error}</p>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${c.divider}`, paddingTop: 10 }}>
                <SmallButton aria-label={t('messageAnnotations.remove')} onClick={() => action(() => annotationDraftStore.remove(sessionId, item.id))} style={{ color: c.textSecondary }}><Icon name="trash" /></SmallButton>
                <span style={{ flex: 1 }} />
                <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
                <button type="submit" data-testid="annotation-save" style={{ ...button, background: c.button.primary.background, color: c.button.primary.tint }}>{t('common.save')}</button>
            </div>
        </form>
    </FloatingPanel>;
}

export function AnnotationComposer({ sessionId }: AnnotationComposerProps) {
    const items = useMessageAnnotations(sessionId);
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
    return <div ref={ref} data-testid="annotation-composer" style={{ position: 'relative', minWidth: 0, padding: items.length ? '12px 14px 0' : 0, color: c.text }}>
        {items.length > 0 && <button ref={trigger} type="button" data-testid="annotation-summary" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(value => !value)} style={{ border: `1px solid ${c.divider}`, borderRadius: 10, padding: '6px 10px', background: c.surface, color: c.text, cursor: 'pointer', display: 'inline-flex', gap: 7, alignItems: 'center', font: 'inherit', fontSize: 12 }}><Icon name="comment" />{t('messageAnnotations.count', { count: items.length })}<span aria-hidden="true">{open ? '⌄' : '⌃'}</span></button>}
        {open && items.length > 0 && trigger.current && <FloatingPanel anchor={trigger.current.getBoundingClientRect()} label={t('messageAnnotations.list')} testId="annotation-list" width={640} maxHeight="min(440px, 50dvh)" onClose={closeList} ignoreOutside={trigger.current}><div id={listId}>
            {items.map((item, index) => <div key={item.id} data-testid={`annotation-row-${item.id}`} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', gap: 8, padding: '14px 0', borderTop: index ? `1px solid ${c.divider}` : undefined, fontSize: 13 }}>
                <span style={{ color: c.textSecondary }}>{index + 1}.</span><div style={{ minWidth: 0 }}><div style={{ color: c.textSecondary, fontSize: 11 }}>{t('messageAnnotations.selectedText')}</div><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65, margin: '3px 0 10px' }}>{item.quote}</div><div style={{ color: c.textSecondary, fontSize: 11 }}>{item.comment ? t('messageAnnotations.yourComment') : t('messageAnnotations.noComment')}</div>{item.comment && <div data-testid="annotation-saved-comment" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65, marginTop: 3 }}>{item.comment}</div>}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><SmallButton data-testid="annotation-edit" aria-label={t('messageAnnotations.editNumber', { number: index + 1 })} onClick={event => { requestEdit(sessionId, item.id, event.currentTarget.getBoundingClientRect(), trigger.current); setOpen(false); }}><Icon name="edit" /></SmallButton><SmallButton data-testid="annotation-remove" aria-label={t('messageAnnotations.removeNumber', { number: index + 1 })} onClick={() => { try { annotationDraftStore.remove(sessionId, item.id); } catch { setError(t('messageAnnotations.saveError')); } }}><Icon name="trash" /></SmallButton></div>
            </div>)}
        </div></FloatingPanel>}
        {error && <div role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error}</div>}
        {editedItem && request && <CommentEditor key={request.sequence} sessionId={sessionId} item={editedItem} request={request} number={items.indexOf(editedItem) + 1} onClose={close} />}
    </div>;
}

export function AnnotatableMessage({ sessionId, messageId, enabled, children }: AnnotationSourceProps) {
    if (!enabled || !sessionId) return <>{children}</>;
    return <AnnotationSource sessionId={sessionId} messageId={messageId}>{children}</AnnotationSource>;
}
function AnnotationSource({ sessionId, messageId, children }: Omit<AnnotationSourceProps, 'enabled'> & { sessionId: string }) {
    const items = useMessageAnnotations(sessionId);
    const annotations = React.useMemo(() => items.filter(a => a.messageId === messageId), [items, messageId]);
    const root = React.useRef<HTMLDivElement>(null);
    const source = React.useRef<HTMLDivElement>(null);
    const uniqueId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const highlightName = `paws-annotation-${uniqueId}`;
    const { c, button } = useAnnotationStyles();
    const [selection, setSelection] = React.useState<ReturnType<typeof readAnnotationSelection>>(null);
    const [error, setError] = React.useState('');
    const [badges, setBadges] = React.useState<Array<{ id: string; top: number; number: number }>>([]);
    const request = React.useSyncExternalStore(subscribeEditor, getEditor, () => null);
    React.useLayoutEffect(() => {
        if (!annotations.length) { setBadges([]); return; }
        let frame: number | undefined;
        const layout = () => {
            if (!source.current || !root.current) return;
            const ranges: Range[] = [];
            const positions: typeof badges = [];

            for (const a of annotations) {
                const range = annotationRange(source.current, a);
                if (!range) continue;
                ranges.push(range);
                const y = range.getBoundingClientRect().bottom - root.current.getBoundingClientRect().top - 24;
                positions.push({ id: a.id, number: items.indexOf(a) + 1, top: y });
            }
            const api = CSS as unknown as { highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void } };
            const HighlightConstructor = (globalThis as unknown as { Highlight?: new(...ranges: Range[]) => unknown }).Highlight;
            if (api.highlights && HighlightConstructor) api.highlights.set(highlightName, new HighlightConstructor(...ranges));
            positions.sort((a, b) => a.top - b.top);
            for (let i = 1; i < positions.length; i++) positions[i].top = Math.max(positions[i].top, positions[i - 1].top + 26);
            setBadges(positions);
        };
        const schedule = () => { if (frame !== undefined) return; frame = requestAnimationFrame(() => { frame = undefined; layout(); }); };
        const observer = new ResizeObserver(schedule);
        const mutations = new MutationObserver(schedule);
        observer.observe(source.current!); mutations.observe(source.current!, { subtree: true, childList: true, characterData: true });
        window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); layout();
        return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); if (frame !== undefined) cancelAnimationFrame(frame); (CSS as unknown as { highlights?: { delete: (name: string) => void } }).highlights?.delete(highlightName); };
    }, [annotations, items, highlightName]);
    React.useEffect(() => {
        if (!selection) return;
        const collapse = () => { if (window.getSelection()?.isCollapsed) setSelection(null); };
        const dismiss = () => setSelection(null);
        const reposition = () => {
            const next = source.current && readAnnotationSelection(source.current, messageId, window.getSelection());
            setSelection(next && next.rect.bottom > 0 && next.rect.top < window.innerHeight ? next : null);
        };
        const pointer = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-testid=annotation-add]')) dismiss(); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
        document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key);
        document.addEventListener('selectionchange', collapse); window.addEventListener('scroll', reposition, true); window.addEventListener('resize', dismiss);
        return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); document.removeEventListener('selectionchange', collapse); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', dismiss); };
    }, [selection, messageId]);
    const capture = () => { if (!editRequest && source.current) setSelection(readAnnotationSelection(source.current, messageId, window.getSelection())); };
    const add = () => {
        if (!selection) return;
        try {
            const { rect, ...data } = selection;
            const item = annotationDraftStore.add(sessionId, data);
            requestEdit(sessionId, item.id, rect, root.current);
            setSelection(null); window.getSelection()?.removeAllRanges();
        } catch { setError(t('messageAnnotations.saveError')); }
    };
    return <div ref={root} tabIndex={-1} style={{ position: 'relative', width: '100%', minWidth: 0 }} data-testid={`annotation-source-${messageId}`}>
        <style>{`::highlight(${highlightName}) { background-color: ${c.surfaceSelected}; color: ${c.text}; }`}</style>
        <div ref={source} onMouseUp={capture} onKeyUp={capture} style={{ paddingInlineEnd: annotations.length ? 30 : 0 }} data-testid="annotation-source-content">{children}</div>
        {badges.map(badge => <button key={badge.id} type="button" data-testid="annotation-badge" aria-label={t('messageAnnotations.editNumber', { number: badge.number })} onClick={event => requestEdit(sessionId, badge.id, event.currentTarget.getBoundingClientRect(), root.current)} style={{ ...button, position: 'absolute', insetInlineEnd: 0, top: badge.top, borderRadius: 24, padding: 0, width: 24, height: 24, background: c.button.primary.background, color: c.button.primary.tint, fontSize: 12 }}>{badge.number}</button>)}
        {selection && !request && createPortal(<button type="button" data-testid="annotation-add" onMouseDown={event => event.preventDefault()} onClick={add} style={{ ...button, position: 'fixed', zIndex: 9999, left: Math.max(12, Math.min(selection.rect.left, window.innerWidth - 170)), top: Math.max(12, Math.min(selection.rect.top - 44, window.innerHeight - 48)), padding: '9px 12px', background: c.surface, border: `1px solid ${c.divider}`, boxShadow: `0 4px 20px ${c.shadow.color}` }}><Icon name="comment" />{t('messageAnnotations.add')}</button>, document.body)}
        {error && <div role="alert" style={{ color: c.textDestructive, fontSize: 12 }}>{error}</div>}
    </div>;
}

export function prepareAnnotatedMessage(sessionId: string, text: string) {
    const snapshot = annotationDraftStore.getSnapshot(sessionId);
    return { text: formatAnnotatedMessage(text, snapshot, { intro: t('messageAnnotations.promptIntro'), annotation: t('messageAnnotations.annotation'), quote: t('messageAnnotations.selectedText'), comment: t('messageAnnotations.yourComment'), explain: t('messageAnnotations.explain'), additional: t('messageAnnotations.additional') }), commit: () => annotationDraftStore.clearSubmitted(sessionId, snapshot) };
}
