import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { getCurrentLanguage, t } from '@/text';
import { GROUP_IDS, THINKING_METHODS, THINKING_SOURCE, type ThinkingGroup, type ThinkingMethodId } from '@/thinking/catalog';
import { buildFollowUpPrompt, type FollowUpAction } from '@/thinking/prompts';
import { useThinkingPreferences } from '@/thinking/preferences.web';
import { stageSessionMessage } from '@/sync/messageStagingQueueRuntime';
import type { ThinkingModeControlProps, ThinkingReplyActionsProps } from './ThinkingMode';

const css = `
.paws-thinking{font-family:inherit;color:var(--tm-text);font-size:14px;line-height:1.5;min-width:0}
.paws-thinking button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--tm-line);background:var(--tm-bg);border-radius:8px;padding:7px 11px;text-align:left}
.paws-thinking button:hover:not(:disabled),.paws-thinking summary:hover{background:var(--tm-hover)}
.paws-thinking button[aria-pressed=true]{background:var(--tm-active);border-color:var(--tm-accent)}
.paws-thinking button:focus-visible,.paws-thinking summary:focus-visible,.paws-thinking a:focus-visible{outline:2px solid var(--tm-accent);outline-offset:2px}
.paws-thinking button:disabled{cursor:default;opacity:.55}
.paws-thinking .tm-trigger{display:flex;align-items:center;gap:5px;max-width:160px;min-height:32px;padding:4px 8px;font-size:12px;white-space:nowrap;overflow:hidden}
.tm-trigger span{overflow:hidden;text-overflow:ellipsis}
.tm-panel{display:flex;flex-direction:column;max-height:min(636px,72dvh);min-height:0}
.tm-intro{margin:0;padding:14px 18px 10px;color:var(--tm-muted);font-size:13px}
.tm-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:0 18px 14px;border-bottom:1px solid var(--tm-line)}
.tm-tabs button{font-size:12px;padding:5px 9px}
.tm-methods{overflow:auto;overscroll-behavior:contain;padding:4px 18px 12px;min-height:0}
.tm-group h3{font-size:13px;color:var(--tm-muted);font-weight:500;margin:16px 0 8px}
.tm-method{border:1px solid var(--tm-line);border-radius:10px;margin-bottom:8px;overflow:hidden;background:var(--tm-bg)}
.tm-method[data-selected=true]{border-color:var(--tm-accent);background:var(--tm-active)}
.paws-thinking .tm-method-select{display:block;border:0;border-radius:0;width:100%;padding:12px 13px;background:transparent}
.tm-method-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tm-method-name{font-size:14px;font-weight:600}
.tm-method-kind{font-size:11px;color:var(--tm-muted);white-space:nowrap;flex-shrink:0}
.tm-purpose{display:block;font-size:13px;color:var(--tm-muted);margin-top:4px}
.tm-method details{padding:0 13px 9px;font-size:11px;color:var(--tm-muted)}
.paws-thinking summary{cursor:pointer;border-radius:4px;width:fit-content;max-width:100%}
.tm-original{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;color:var(--tm-text);margin:10px 0;user-select:text}
.tm-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 18px;border-top:1px solid var(--tm-line);font-size:12px}
.tm-footer a{color:var(--tm-muted)}
.tm-followup{margin-top:12px;max-width:100%}
.paws-thinking .tm-followup-toggle{border:0;padding:4px 0;color:var(--tm-muted);background:transparent;font-size:12px;display:flex;align-items:center;gap:5px}
.paws-thinking .tm-followup-toggle:hover{color:var(--tm-text);background:transparent}
.tm-followup-body{margin-top:7px;padding:12px;border:1px solid var(--tm-line);border-radius:10px;background:var(--tm-bg)}
.tm-followup-hint{font-size:12px;color:var(--tm-muted);margin:0 0 10px}
.tm-followup-buttons{display:flex;flex-wrap:wrap;gap:7px}
.tm-suggestions{margin-top:12px;font-size:12px;color:var(--tm-muted)}
.paws-thinking .tm-question{display:block;border:0;background:transparent;padding:5px 0;color:var(--tm-text);font-size:12px}
.tm-reference{margin-top:10px;font-size:12px;color:var(--tm-muted)}
.tm-reference pre{max-height:240px;overflow:auto}
.tm-feedback{display:block;font-size:12px;margin-top:9px;color:var(--tm-muted)}
@media(max-width:480px){.tm-panel{max-height:72dvh}.tm-tabs{padding:0 12px 10px}.tm-methods{padding:4px 12px 10px}.tm-intro{padding:12px}.tm-footer{padding:10px 12px}.paws-thinking .tm-trigger{max-width:116px}.tm-method-top{align-items:flex-start}.tm-method-kind{font-size:10px}}
`;
function useThinkingStyle(): React.CSSProperties {
    const { theme } = useUnistyles();
    React.useEffect(() => {
        if (!document.getElementById('paws-thinking-style')) {
            const sheet = document.createElement('style');
            sheet.id = 'paws-thinking-style'; sheet.textContent = css;
            document.head.appendChild(sheet);
        }
    }, []);
    return {
        '--tm-bg': theme.colors.surface, '--tm-text': theme.colors.text,
        '--tm-muted': theme.colors.textSecondary, '--tm-line': theme.colors.divider,
        '--tm-hover': theme.colors.surfacePressed, '--tm-active': theme.colors.surfaceSelected,
        '--tm-accent': theme.colors.accent,
        fontFamily: Typography.default().fontFamily,
    } as React.CSSProperties;
}
function saveFailed() { Modal.alert(t('common.error'), t('thinkingMode.localSaveFailed')); }

export function ThinkingModeSetting() {
    const { theme } = useUnistyles();
    const preferences = useThinkingPreferences();
    return <Item title={t('thinkingMode.title')} subtitle={t('thinkingMode.settingDescription')}
        icon={<Ionicons name="bulb-outline" size={29} color={theme.colors.accent} />}
        showChevron={false} rightElement={<Switch accessibilityLabel={t('thinkingMode.title')}
            value={preferences.enabled} onValueChange={value => { if (!preferences.setEnabled(value)) saveFailed(); }} />} />;
}

export function ThinkingModeControl({ sessionId }: ThinkingModeControlProps) {
    const preferences = useThinkingPreferences(sessionId);
    const style = useThinkingStyle();
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const restoreFocus = React.useRef(false);
    const [open, setOpen] = React.useState(false);
    const [group, setGroup] = React.useState<ThinkingGroup | 'all'>('all');
    React.useEffect(() => { setOpen(false); }, [sessionId, preferences.enabled]);
    if (!preferences.enabled || !sessionId) return null;
    const close = () => {
        restoreFocus.current = true;
        setOpen(false);
    };
    const choose = (method: ThinkingMethodId | null) => {
        if (!preferences.setMethod(method)) { saveFailed(); return; }
        close();
    };
    const chinese = getCurrentLanguage().startsWith('zh');
    return <div className="paws-thinking" style={style}>
        <button ref={triggerRef} type="button" className="tm-trigger" data-testid="thinking-mode-trigger"
            aria-label={t('thinkingMode.select')} aria-haspopup="dialog" aria-expanded={open}
            aria-pressed={Boolean(preferences.method)} title={t('thinkingMode.methodHint')}
            onClick={() => setOpen(value => !value)}>
            <Ionicons name="bulb-outline" size={15} />
            <span>{preferences.method ? t(`thinkingMode.methods.${preferences.method}.name`) : t('thinkingMode.title')}</span>
        </button>
        <DesktopDialogFrame visible={open} onClose={close} onDismiss={() => {
            // Wait for RN Web's exit animation and focus-trap cleanup.
            if (restoreFocus.current) {
                restoreFocus.current = false;
                requestAnimationFrame(() => triggerRef.current?.focus());
            }
        }} title={t('thinkingMode.select')} maxWidth={640}
            testID="thinking-mode-dialog">
            <div className="paws-thinking tm-panel" style={style}>
                <p className="tm-intro">{t('thinkingMode.intro')}</p>
                <div className="tm-tabs" role="group" aria-label={t('thinkingMode.title')}>
                    {(['all', ...GROUP_IDS] as const).map(id => <button key={id} type="button" aria-pressed={group === id}
                        data-testid={`thinking-group-${id}`} onClick={() => setGroup(id)}>
                        {id === 'all' ? t('thinkingMode.all') : t(`thinkingMode.groups.${id}`)}
                    </button>)}
                </div>
                <div className="tm-methods">
                    {GROUP_IDS.filter(id => group === 'all' || id === group).map(id => <section className="tm-group" key={id}>
                        <h3>{t(`thinkingMode.groups.${id}`)}</h3>
                        {THINKING_METHODS.filter(method => method.group === id).map(method => <div className="tm-method"
                            key={method.id} data-selected={preferences.method === method.id}>
                            <button type="button" className="tm-method-select" aria-pressed={preferences.method === method.id}
                                data-testid={`thinking-method-${method.id}`} onClick={() => choose(method.id)}>
                                <span className="tm-method-top"><span className="tm-method-name">
                                    {method.number ? `${String(method.number).padStart(2, '0')} · ` : ''}{t(`thinkingMode.methods.${method.id}.name`)}
                                </span><span className="tm-method-kind">{t(`thinkingMode.${method.kind}`)}</span></span>
                                <span className="tm-purpose">{t(`thinkingMode.methods.${method.id}.purpose`)}</span>
                            </button>
                            <details><summary>{t('thinkingMode.original')}</summary>
                                <pre className="tm-original">{chinese ? method.originalPrompt : method.originalPromptEn}</pre>
                                {method.adaptation && <><strong>{t('thinkingMode.adaptation')}</strong><pre className="tm-original">{method.adaptation}</pre></>}
                            </details>
                        </div>)}
                    </section>)}
                </div>
                <div className="tm-footer">
                    <a href={`${THINKING_SOURCE.repository}/tree/${THINKING_SOURCE.commit}`} target="_blank" rel="noreferrer">{t('thinkingMode.source')} · thinking-prompts-skill</a>
                    <button type="button" data-testid="thinking-mode-clear" onClick={() => choose(null)}>{t('thinkingMode.clear')}</button>
                </div>
            </div>
        </DesktopDialogFrame>
    </div>;
}

export function ThinkingReplyActions({ sessionId, messageId, text }: ThinkingReplyActionsProps) {
    const { enabled } = useThinkingPreferences(sessionId);
    const style = useThinkingStyle();
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [accepted, setAccepted] = React.useState<FollowUpAction[]>([]);
    const [feedback, setFeedback] = React.useState<'queued' | 'failed' | null>(null);
    const inFlight = React.useRef(false);
    const acceptedRef = React.useRef(new Set<FollowUpAction>());
    const panelId = React.useId();
    React.useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
    if (!enabled || !text.trim()) return null;
    const labels = { draw: t('thinkingMode.draw'), example: t('thinkingMode.example'), continue: t('thinkingMode.continue'),
        why: t('thinkingMode.suggestWhy'), action: t('thinkingMode.suggestAction') };
    const send = async (action: FollowUpAction) => {
        if (inFlight.current || acceptedRef.current.has(action)) return;
        inFlight.current = true; setBusy(true); setFeedback(null);
        // Capture the clicked reply now; later messages and composer changes cannot retarget it.
        const prompt = buildFollowUpPrompt(action, { id: messageId, text });
        const excerpt = text.replace(/\s+/g, ' ').slice(0, 180);
        try {
            await stageSessionMessage(sessionId, prompt, undefined, 'queue', {
                displayText: `${labels[action]}\n\n> ${excerpt}${text.length > 180 ? '…' : ''}`,
            });
            acceptedRef.current.add(action); setAccepted([...acceptedRef.current]); setFeedback('queued');
        } catch { setFeedback('failed'); }
        finally { inFlight.current = false; setBusy(false); }
    };
    return <div className="paws-thinking tm-followup" style={style} data-testid={`thinking-followup-${messageId}`}>
        <button type="button" className="tm-followup-toggle" aria-expanded={open} aria-controls={panelId}
            onClick={() => setOpen(value => !value)}>
            <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} />{t('thinkingMode.followUp')}
        </button>
        {open && <div id={panelId} className="tm-followup-body">
            <p className="tm-followup-hint">{t('thinkingMode.followUpHint')}</p>
            <div className="tm-followup-buttons">
                {(['draw', 'example', 'continue'] as const).map(action => <button key={action} type="button"
                    data-testid={`thinking-followup-${action}`} disabled={busy || accepted.includes(action)}
                    onClick={() => { void send(action); }}>{labels[action]}</button>)}
            </div>
            <div className="tm-suggestions">{t('thinkingMode.suggestions')}
                {(['why', 'action'] as const).map(action => <button key={action} type="button" className="tm-question"
                    disabled={busy || accepted.includes(action)} onClick={() => { void send(action); }}>{labels[action]}</button>)}
            </div>
            <details className="tm-reference"><summary>{t('thinkingMode.reference')}</summary><pre className="tm-original">{text}</pre></details>
            {(busy || feedback) && <span className="tm-feedback" role="status">{busy ? t('thinkingMode.sending') : feedback === 'queued' ? t('thinkingMode.queued') : t('thinkingMode.failed')}</span>}
        </div>}
    </div>;
}
