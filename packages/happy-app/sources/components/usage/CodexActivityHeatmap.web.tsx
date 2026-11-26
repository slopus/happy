import * as React from 'react';
import { createPortal } from 'react-dom';
import { useUnistyles } from 'react-native-unistyles';
import { WEB_DEFAULT_FONT_FAMILY } from '@/constants/Typography';
import { t } from '@/text';
import type { CodexActivityHeatmapProps } from './CodexActivityHeatmap.types';
import { useActivityDisclosure } from './useActivityDisclosure';
import { ACTIVITY_CELL_SIZE as CELL, ACTIVITY_GAP as GAP, ACTIVITY_PITCH as PITCH, ACTIVITY_LEVEL_ALPHA as LEVEL_ALPHA, filterActivityMonths, getActivityMetrics, type ActivityMetricKey } from './activityPresentation';
import { multiplyColorOpacity } from '@/utils/colorOpacity';
import {
    buildActivityCalendar, formatActivityTokens, getActivityLevel,
    type ActivityDay, type ActivitySnapshot,
} from './codexActivityCalendar';

// Independently implemented for Paws. Rare UI's public demo informed the
// compact calendar and disclosure pattern; no Rare UI source is included.
const css = `
.paws-activity{margin:20px 12px 24px;padding:18px;border:1px solid var(--activity-border);border-radius:16px;background:var(--activity-surface);color:var(--activity-text);box-sizing:border-box;min-width:0}
.paws-activity *{box-sizing:border-box}
.paws-activity button{font-family:inherit}
.paws-activity-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.paws-activity h3{margin:0;font-size:16px;line-height:24px;font-weight:600}
.paws-activity-scope,.paws-activity-range,.paws-activity-note{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--activity-secondary)}
.paws-activity-total{text-align:right;font-size:21px;line-height:26px;font-weight:600;font-variant-numeric:tabular-nums}
.paws-activity-total small{display:block;font-size:11px;line-height:18px;color:var(--activity-secondary);font-weight:400}
.paws-activity-stage{position:relative;min-height:272px;padding-bottom:84px;margin-top:14px}
.paws-activity-calendar{display:flex;gap:10px;min-width:0}
.paws-activity-weekdays{flex:0 0 27px;position:relative;margin-top:24px;height:109px;font-size:10px;color:var(--activity-secondary)}
.paws-activity-scroll{overflow-x:auto;overflow-y:hidden;min-width:0;flex:1;scrollbar-width:thin;overscroll-behavior-x:contain;padding:3px 3px 9px}
.paws-activity-grid{display:flex;gap:var(--activity-gap);position:relative;padding-top:21px}
.paws-activity-week{display:flex;flex-direction:column;gap:var(--activity-gap);flex:0 0 var(--activity-cell)}
.paws-activity-month{position:absolute;top:0;font-size:10px;line-height:14px;white-space:nowrap;color:var(--activity-secondary)}
.paws-activity-cell{display:block;flex:0 0 var(--activity-cell);width:var(--activity-cell);height:var(--activity-cell);border:0;border-radius:3px;padding:0;cursor:pointer;outline-offset:1px}
.paws-activity-cell:hover{outline:1px solid var(--activity-secondary)}
.paws-activity-cell[aria-pressed=true]{outline:1px solid var(--activity-text)}
.paws-activity-cell:focus-visible{outline:2px solid var(--activity-text);outline-offset:1px}
.paws-activity-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;font-size:11px;color:var(--activity-secondary);margin-top:6px}
.paws-activity-swatch{display:inline-block;width:10px;height:10px;border-radius:2px}
.paws-activity-footer{position:absolute;inset:calc(100% - 68px) 0 0;border:1px solid var(--activity-border);border-radius:14px;overflow:hidden;background:var(--activity-panel);backdrop-filter:blur(16px);display:flex;flex-direction:column;transition:top 480ms cubic-bezier(.22,1,.36,1)}
.paws-activity-footer[data-open=true]{top:0}
.paws-activity-summary{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:66px;padding:10px 14px;border:0;background:transparent;color:var(--activity-text);text-align:left;cursor:pointer;flex-shrink:0}
.paws-activity-summary:hover,.paws-activity-day-nav button:hover{background:var(--activity-pressed)}
.paws-activity-summary:focus-visible,.paws-activity-day-nav button:focus-visible{outline:2px solid var(--activity-text);outline-offset:-3px}
.paws-activity-summary strong{font-size:13px;line-height:20px;font-weight:600}
.paws-activity-summary small{display:block;color:var(--activity-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.paws-activity-summary-main{min-width:0}
.paws-activity-summary-main small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.paws-activity-summary-end{display:flex;gap:10px;align-items:center;flex-shrink:0}
.paws-activity-stack{display:flex;padding-left:7px;transition:opacity 160ms ease}
.paws-activity-stack>[data-badge-anchor]{width:28px;height:28px;margin-left:-7px}
.paws-activity-footer[data-open=true] .paws-activity-stack{opacity:0}
.paws-activity-toggle{font-size:12px;white-space:nowrap;color:var(--activity-secondary)}
.paws-activity-toggle-mark{display:inline-block;margin-left:6px;font-size:18px;line-height:20px}
.paws-activity-panel-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 14px 12px;opacity:0;visibility:hidden;transition:opacity 180ms ease,visibility 0s 280ms}
.paws-activity-footer[data-open=true] .paws-activity-panel-body{opacity:1;visibility:visible;transition:opacity 240ms ease 70ms,visibility 0s}
.paws-activity-metric-row dt,.paws-activity-metric-row dd{opacity:0;transform:translateY(16px);transition:opacity 180ms ease,transform 240ms ease}
.paws-activity-footer[data-open=true] .paws-activity-metric-row dt,.paws-activity-footer[data-open=true] .paws-activity-metric-row dd{opacity:1;transform:none;transition:opacity 280ms ease calc(var(--activity-row)*80ms),transform 420ms cubic-bezier(.2,.8,.2,1.1) calc(var(--activity-row)*80ms)}
.paws-activity-day-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--activity-border);padding-top:2px}
.paws-activity-day-nav button{border:0;border-radius:6px;background:transparent;color:var(--activity-secondary);min-height:36px;padding:7px 10px;font-size:12px;cursor:pointer}
.paws-activity-day-nav button:disabled{opacity:.4;cursor:default}
.paws-activity-metrics{margin:2px 0 8px}
.paws-activity-metric-row{display:flex;align-items:center;gap:12px;min-height:44px}
.paws-activity-metric-anchor{width:28px;height:28px;flex-shrink:0}
.paws-activity-metric-row dt{font-size:13px;line-height:18px;color:var(--activity-secondary);min-width:0;flex:1}
.paws-activity-metric-row dd{margin:0;font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.paws-activity-badge-layer{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:visible}
.paws-activity-badge{position:absolute;left:0;top:0;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;border:2px solid var(--activity-high);font-size:11px;font-weight:600;color:var(--activity-text);will-change:transform}
.paws-activity-tooltip{box-sizing:border-box;position:fixed;z-index:100000;pointer-events:none;width:max-content;max-width:min(246px,calc(100vw - 16px));padding:8px 11px;border:1px solid var(--activity-border);border-radius:8px;background:var(--activity-high);color:var(--activity-text);font-family:inherit;font-size:12px;line-height:18px;box-shadow:0 4px 18px var(--activity-shadow);transform-origin:center bottom;transition:opacity 140ms ease,transform 140ms ease}
.paws-activity-tooltip strong{display:block;font-size:12px}
.paws-activity-tooltip[data-visible=false]{opacity:0;transform:translateY(3px) scale(.96)}
.paws-activity[data-entering=true] .paws-activity-week{animation:paws-activity-column 200ms cubic-bezier(.22,1,.36,1) both;animation-delay:calc(var(--activity-column)*12ms)}
.paws-activity[data-entering=true] .paws-activity-month{animation:paws-activity-label 300ms ease both;animation-delay:var(--activity-sweep)}
@keyframes paws-activity-column{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:none}}
@keyframes paws-activity-label{from{opacity:0;filter:blur(3px)}to{opacity:1;filter:blur(0)}}
.paws-activity[data-reduced-motion=true] *,.paws-activity-tooltip[data-reduced-motion=true]{animation:none!important;transition:none!important}
@media(prefers-reduced-motion:reduce){.paws-activity *,.paws-activity-tooltip{animation:none!important;transition:none!important}}
@media(prefers-reduced-transparency:reduce){.paws-activity-footer{background:var(--activity-high);backdrop-filter:none}}
@media(max-width:520px){.paws-activity{padding:14px}.paws-activity-total{text-align:left;font-size:18px}.paws-activity-header{gap:10px}.paws-activity-summary{padding-inline:10px}.paws-activity-summary-end{gap:6px}.paws-activity-stack>[data-badge-anchor]{width:24px;height:24px}.paws-activity-badge{width:24px;height:24px}.paws-activity-toggle{font-size:11px}.paws-activity-day-nav button{min-height:44px}}
`;

function useActivityMotionPreference() {
    const [reduced, setReduced] = React.useState(() => typeof window === 'undefined' || !window.matchMedia
        ? true : window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    React.useEffect(() => {
        const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!query) return;
        const update = () => setReduced(query.matches);
        update(); query.addEventListener?.('change', update);
        return () => query.removeEventListener?.('change', update);
    }, []);
    return reduced;
}

function ActivityTooltip({ day, anchor, language, variables, reduced, id }: {
    day?: ActivityDay; anchor?: { left: number; top: number; bottom: number; width: number };
    language: string; variables: React.CSSProperties; reduced: boolean; id: string;
}) {
    const [content, setContent] = React.useState<{ day: ActivityDay; anchor: NonNullable<typeof anchor> } | null>(null);
    const [visible, setVisible] = React.useState(false);
    const [position, setPosition] = React.useState({ left: 8, top: 8 });
    const ref = React.useRef<HTMLDivElement>(null);
    const animation = React.useRef<Animation | null>(null);
    React.useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (day && anchor) { setContent({ day, anchor }); setVisible(true); }
        else {
            setVisible(false);
            if (reduced) setContent(null);
            else timer = setTimeout(() => setContent(null), 140);
        }
        return () => { if (timer) clearTimeout(timer); };
    }, [day, anchor, reduced]);
    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!content || !node) return;
        const { width, height } = node.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, content.anchor.left + content.anchor.width / 2 - width / 2));
        const above = content.anchor.top - height - 8;
        const top = above >= 8 ? above : Math.max(8, Math.min(window.innerHeight - height - 8, content.anchor.bottom + 8));
        setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    }, [content, language]);
    React.useLayoutEffect(() => {
        const node = ref.current;
        animation.current?.cancel();
        if (node && visible && !reduced && typeof node.animate === 'function') {
            animation.current = node.animate([{ opacity: 0, transform: 'translateY(3px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
        }
    }, [visible, reduced]);
    React.useEffect(() => () => animation.current?.cancel(), []);
    if (!content || typeof document === 'undefined') return null;
    return createPortal(<div ref={ref} role={visible ? 'tooltip' : undefined} aria-hidden={!visible} id={id}
        className="paws-activity-tooltip" data-visible={visible} data-reduced-motion={reduced}
        style={{ ...variables, left: position.left, top: position.top }}>
        <strong>{content.day.date}</strong>{formatActivityTokens(content.day.totalTokens, language, true)} token · {content.day.sessions} {t('machine.codexUsageSessions')}
    </div>, document.body);
}

export function CodexActivityHeatmap(props: CodexActivityHeatmapProps) {
    const { snapshot, language } = props;
    const { open: expanded, setOpen, toggle } = useActivityDisclosure(props);
    const reduced = useActivityMotionPreference();
    const { theme } = useUnistyles();
    const calendar = React.useMemo(() => buildActivityCalendar(snapshot), [snapshot]);
    const [chosenDate, setChosenDate] = React.useState<string | null>(null);
    const [focusDate, setFocusDate] = React.useState<string | null>(null);
    const [preview, setPreview] = React.useState<{ date: string; anchor: { left: number; top: number; bottom: number; width: number } } | null>(null);
    const [entering, setEntering] = React.useState(!reduced && !expanded);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const summaryRef = React.useRef<HTMLButtonElement>(null);
    const badgeRefs = React.useRef(new Map<ActivityMetricKey, HTMLSpanElement>());
    const badgeAnimations = React.useRef<Animation[]>([]);
    const previousOpen = React.useRef(expanded);
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const initialized = React.useRef(false);
    const dismissEscape = React.useRef(false);
    const dismissedPreviewDate = React.useRef<string | null>(null);
    const cells = React.useRef(new Map<string, HTMLButtonElement>());
    const detailId = React.useId();
    const tooltipId = React.useId();
    const fallback = [...calendar.days].reverse().find(day => day.totalTokens > 0) ?? calendar.days.at(-1);
    const selected = calendar.days.find(day => day.date === chosenDate) ?? fallback;
    const previewDay = calendar.days.find(day => day.date === preview?.date);
    const tabDate = calendar.days.some(day => day.date === focusDate) ? focusDate : selected?.date;
    const locale = language === 'zh-Hans' ? 'zh-CN' : language === 'zh-Hant' ? 'zh-TW' : language;
    const monthFormatter = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }), [locale]);
    const weekdayFormatter = React.useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }), [locale]);
    const variables = {
        '--activity-cell': `${CELL}px`,
        '--activity-gap': `${GAP}px`,
        '--activity-sweep': `${Math.max(0, calendar.weeks.length - 1) * 12 + 200}ms`,
        '--activity-panel': multiplyColorOpacity(theme.colors.surfaceHigh, 0.96),
        '--activity-surface': theme.colors.surface,
        '--activity-high': theme.colors.surfaceHigh,
        '--activity-pressed': theme.colors.surfacePressed,
        '--activity-border': theme.colors.divider,
        '--activity-text': theme.colors.text,
        '--activity-secondary': theme.colors.textSecondary,
        '--activity-shadow': multiplyColorOpacity(theme.colors.shadow.color, theme.colors.shadow.opacity),
        fontFamily: WEB_DEFAULT_FONT_FAMILY,
    } as React.CSSProperties;
    const dayLabel = (day: ActivityDay) => t('machine.codexUsageHeatmapDay', {
        date: day.date, tokens: formatActivityTokens(day.totalTokens, language, true), sessions: day.sessions,
    });
    const background = (level: number) => level
        ? multiplyColorOpacity(theme.colors.accent, LEVEL_ALPHA[level])
        : theme.colors.surfaceHigh;

    React.useLayoutEffect(() => {
        // Do not reset the reader's position when new data arrives or the
        // dialog changes size. A new machine mounts a new keyed component.
        if (!calendar.days.length) { initialized.current = false; return; }
        if (initialized.current || !scrollRef.current) return;
        scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
        initialized.current = true;
    }, [calendar.days.length]);

    React.useEffect(() => {
        const updateAfterScroll = () => {
            // Keyboard focus can scroll the grid into view. Keep its tooltip
            // attached to the final cell position; pointer previews still close.
            const focused = [...cells.current].find(([, element]) => element === document.activeElement);
            const clip = scrollRef.current?.getBoundingClientRect();
            const rect = focused?.[1].getBoundingClientRect();
            if (!focused || focused[0] === dismissedPreviewDate.current || !clip || !rect || rect.width <= 0 || rect.height <= 0
                || rect.right <= Math.max(0, clip.left) || rect.left >= Math.min(window.innerWidth, clip.right)
                || rect.bottom <= Math.max(0, clip.top) || rect.top >= Math.min(window.innerHeight, clip.bottom)) {
                setPreview(null);
                return;
            }
            setPreview({ date: focused[0], anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } });
        };
        // RN Web's parent Modal closes on keyup. Dismissing a tooltip on
        // keydown must consume that same keyup, rather than closing both layers.
        const consumeKeyUp = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !dismissEscape.current) return;
            dismissEscape.current = false;
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener('scroll', updateAfterScroll, true);
        window.addEventListener('resize', updateAfterScroll);
        document.addEventListener('keyup', consumeKeyUp, true);
        return () => {
            window.removeEventListener('scroll', updateAfterScroll, true);
            window.removeEventListener('resize', updateAfterScroll);
            document.removeEventListener('keyup', consumeKeyUp, true);
        };
    }, []);

    const showPreview = (day: ActivityDay, element: HTMLButtonElement) => {
        dismissedPreviewDate.current = null;
        const rect = element.getBoundingClientRect();
        setPreview({ date: day.date, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } });
    };
    const navigate = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        const moves: Record<string, number> = {
            ArrowLeft: index - 7, ArrowRight: index + 7,
            ArrowUp: index - 1, ArrowDown: index + 1,
            Home: 0, End: calendar.days.length - 1,
        };
        const target = moves[event.key];
        if (target === undefined) return;
        event.preventDefault();
        const day = calendar.days[Math.max(0, Math.min(calendar.days.length - 1, target))];
        setFocusDate(day.date);
        cells.current.get(day.date)?.focus();
    };

    const placeBadges = React.useCallback((animate: boolean) => {
        const panel = panelRef.current;
        if (!panel) return;
        const bounds = panel.getBoundingClientRect();
        const origin = { left: bounds.left + panel.clientLeft, top: bounds.top + panel.clientTop };
        const starts = new Map([...badgeRefs.current].map(([key, node]) => [key, node.getBoundingClientRect()]));
        badgeAnimations.current.forEach(animation => animation.cancel());
        badgeAnimations.current = [];
        for (const [key, node] of badgeRefs.current) {
            const target = panel.querySelector<HTMLElement>(expanded ? `[data-metric-anchor="${key}"]` : `[data-badge-anchor="${key}"]`);
            if (!target) continue;
            const rect = target.getBoundingClientRect();
            const transform = `translate(${rect.left - origin.left}px, ${rect.top - origin.top}px)`;
            node.style.transform = transform; node.style.opacity = '1';
            const start = starts.get(key);
            if (animate && !reduced && start && typeof node.animate === 'function') {
                badgeAnimations.current.push(node.animate([
                    { transform: `translate(${start.left - origin.left}px, ${start.top - origin.top}px)` },
                    { transform },
                ], { duration: 480, easing: 'cubic-bezier(.2,.85,.25,1.08)' }));
            }
        }
    }, [expanded, reduced]);
    React.useLayoutEffect(() => {
        placeBadges(previousOpen.current !== expanded);
        previousOpen.current = expanded;
        setPreview(null);
        const active = document.activeElement;
        if (expanded ? [...cells.current.values()].includes(active as HTMLButtonElement)
            : panelRef.current?.querySelector('.paws-activity-panel-body')?.contains(active)) summaryRef.current?.focus();
    }, [expanded, placeBadges, calendar.days.length, language]);
    React.useLayoutEffect(() => {
        if (reduced) setEntering(false);
    }, [reduced]);
    React.useEffect(() => {
        const panel = panelRef.current;
        if (!panel || typeof ResizeObserver === 'undefined') return;
        let width = panel.clientWidth;
        const observer = new ResizeObserver(() => {
            if (panel.clientWidth !== width) { width = panel.clientWidth; placeBadges(false); }
        });
        observer.observe(panel);
        return () => observer.disconnect();
    }, [placeBadges, calendar.days.length]);
    React.useEffect(() => () => badgeAnimations.current.forEach(animation => animation.cancel()), []);
    const dismissInnerLayer = (event: React.KeyboardEvent) => {
        if (event.key !== 'Escape' || (!previewDay && !expanded)) return;
        dismissEscape.current = true; event.preventDefault(); event.stopPropagation();
        if (previewDay) { dismissedPreviewDate.current = previewDay.date; setPreview(null); }
        else { setOpen(false); summaryRef.current?.focus(); }
    };
    if (!calendar.days.length || !selected) return null;
    const metrics = getActivityMetrics(selected);
    const labels = { input: t('codexActivity.uncachedInput'), cache: t('codexActivity.cacheRead'), output: t('codexActivity.output') };
    const shortLabels = { input: t('codexActivity.metricInputShort'), cache: t('codexActivity.metricCacheShort'), output: t('codexActivity.metricOutputShort') };
    const selectedIndex = calendar.days.findIndex(day => day.date === selected.date);
    const chooseOffset = (offset: number) => { const next = calendar.days[selectedIndex + offset]; if (next) { setChosenDate(next.date); setFocusDate(next.date); } };
    const warningCount = (snapshot as ActivitySnapshot & { warnings?: unknown[] })?.warnings?.length ?? 0;
    return (
        <section className="paws-activity" style={variables} aria-label={t('machine.codexUsageHeatmap')} data-testid="codex-activity"
            data-entering={entering} data-reduced-motion={reduced} onKeyDown={dismissInnerLayer}>
            <style>{css}</style>
            <header className="paws-activity-header">
                <div><h3>{t('machine.codexUsageHeatmap')}</h3><p className="paws-activity-scope">{t('codexActivity.scope')}</p><p className="paws-activity-range">{calendar.from} – {calendar.to}</p></div>
                <div className="paws-activity-total" title={formatActivityTokens(calendar.total, language, true)}>{formatActivityTokens(calendar.total, language)}<small>{t('codexActivity.processed')}</small></div>
            </header>
            <div className="paws-activity-stage">
                <div inert={expanded} aria-hidden={expanded}>
                    <div className="paws-activity-calendar">
                        <div className="paws-activity-weekdays" aria-hidden="true">{[1, 3, 5].map(weekday => <span key={weekday} style={{ position: 'absolute', top: weekday * PITCH }}>{weekdayFormatter.format(new Date(Date.UTC(2026, 0, 4 + weekday)))}</span>)}</div>
                        <div ref={scrollRef} className="paws-activity-scroll" data-testid="codex-usage-heatmap-scroll">
                            <div className="paws-activity-grid" style={{ width: calendar.weeks.length * PITCH - GAP }} data-testid="codex-usage-heatmap">
                                {filterActivityMonths(calendar.months).map(month => <span className="paws-activity-month" key={month.key} style={{ left: month.weekIndex * PITCH }} onAnimationEnd={() => setEntering(false)}>{monthFormatter.format(new Date(`${month.date}T00:00:00Z`))}</span>)}
                                {calendar.weeks.map((week, column) => <div className="paws-activity-week" key={column} style={{ '--activity-column': column } as React.CSSProperties}>
                                    {week.map((day, row) => day ? <button type="button" className="paws-activity-cell" key={day.date}
                                        ref={element => { if (element) cells.current.set(day.date, element); else cells.current.delete(day.date); }}
                                        data-testid={`codex-usage-day-${day.date}`} data-level={getActivityLevel(day.totalTokens, calendar.max)}
                                        style={{ backgroundColor: background(getActivityLevel(day.totalTokens, calendar.max)) }} tabIndex={day.date === tabDate ? 0 : -1}
                                        aria-pressed={day.date === selected.date} aria-label={dayLabel(day)} aria-describedby={previewDay?.date === day.date ? tooltipId : undefined}
                                        onMouseEnter={event => showPreview(day, event.currentTarget)} onMouseLeave={event => { if (document.activeElement !== event.currentTarget) setPreview(null); }}
                                        onFocus={event => { setFocusDate(day.date); showPreview(day, event.currentTarget); }} onBlur={() => setPreview(null)}
                                        onKeyDown={event => navigate(event, column * 7 + row - (7 - calendar.weeks[0].filter(Boolean).length))}
                                        onClick={() => { setChosenDate(day.date); setFocusDate(day.date); }}
                                    /> : <span key={`padding-${row}`} aria-hidden="true" style={{ width: CELL, height: CELL }} />)}
                                </div>)}
                            </div>
                        </div>
                    </div>
                    <div className="paws-activity-legend" aria-label={t('machine.codexUsageHeatmapLegend')}><span>{t('machine.codexUsageHeatmapLegend')}</span>{LEVEL_ALPHA.map((_, level) => <span key={level} className="paws-activity-swatch" style={{ background: background(level) }} />)}</div>
                </div>
                <div ref={panelRef} className="paws-activity-footer" data-open={expanded}>
                    <button ref={summaryRef} className="paws-activity-summary" type="button" aria-expanded={expanded} aria-controls={detailId}
                        aria-label={`${dayLabel(selected)}. ${expanded ? t('codexActivity.hideDetails') : t('codexActivity.showDetails')}`}
                        onClick={toggle} data-testid="codex-activity-details-toggle">
                        <span className="paws-activity-summary-main"><strong>{selected.date}</strong><small>{formatActivityTokens(selected.totalTokens, language)} token · {selected.sessions} {t('machine.codexUsageSessions')}</small></span>
                        <span className="paws-activity-summary-end"><span className="paws-activity-stack" aria-hidden="true">{metrics.map(metric => <span key={metric.key} data-badge-anchor={metric.key} />)}</span><span className="paws-activity-toggle">{expanded ? t('codexActivity.hideDetails') : t('codexActivity.showDetails')}<span className="paws-activity-toggle-mark" aria-hidden="true">{expanded ? '−' : '+'}</span></span></span>
                    </button>
                    <div className="paws-activity-panel-body" inert={!expanded} aria-hidden={!expanded} onScroll={() => placeBadges(false)}>
                        <div className="paws-activity-day-nav"><button type="button" disabled={selectedIndex <= 0} onClick={() => chooseOffset(-1)}>{t('codexActivity.previousDay')}</button><button type="button" disabled={selectedIndex >= calendar.days.length - 1} onClick={() => chooseOffset(1)}>{t('codexActivity.nextDay')}</button></div>
                        <div id={detailId} role="region" aria-label={t('codexActivity.detailsLabel')} data-testid={expanded ? 'codex-usage-detail' : undefined}>
                            <dl className="paws-activity-metrics">{metrics.map((metric, index) => <div className="paws-activity-metric-row" key={metric.key} style={{ '--activity-row': index } as React.CSSProperties}>
                                <span className="paws-activity-metric-anchor" data-metric-anchor={metric.key} aria-hidden="true" /><dt>{labels[metric.key]}</dt><dd title={formatActivityTokens(metric.value, language, true)}>{formatActivityTokens(metric.value, language)}</dd>
                            </div>)}</dl>
                            <p className="paws-activity-note">{t('codexActivity.total')}: {formatActivityTokens(selected.totalTokens, language, true)} token</p><p className="paws-activity-note">{t('codexActivity.cacheNote')}</p>
                        </div>
                    </div>
                    <div className="paws-activity-badge-layer" aria-hidden="true">{metrics.map((metric, index) => <span key={metric.key}
                        ref={node => { if (node) badgeRefs.current.set(metric.key, node); else badgeRefs.current.delete(metric.key); }}
                        className="paws-activity-badge" data-metric-badge={metric.key} style={{ opacity: 0, background: multiplyColorOpacity(theme.colors.accent, [0.24, 0.4, 0.64][index]) }}>{shortLabels[metric.key]}</span>)}</div>
                </div>
            </div>
            {snapshot && <p className="paws-activity-note">{t('machine.codexUsageScannedAt')}: {new Date(snapshot.scannedAt).toLocaleString(locale, { timeZone: snapshot.timeZone })}{snapshot.timeZone ? ` · ${snapshot.timeZone}` : ''}</p>}
            {warningCount > 0 && <p role="status" className="paws-activity-note">{t('codexActivity.incomplete')}</p>}
            {calendar.total === 0 && <p className="paws-activity-note">{t('codexActivity.noActivity')}</p>}
            <ActivityTooltip day={previewDay} anchor={preview?.anchor} language={language} variables={variables} reduced={reduced} id={tooltipId} />
        </section>
    );
}
