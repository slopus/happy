import * as React from 'react';
import type { ComposerAgentActionProps } from './ComposerAgentAction';
const brands: Record<string, { background: string; ink: string }> = {
    claude: { background: '#D97757', ink: '#201A17' },
    codex: { background: '#3941FF', ink: '#FFFFFF' },
    opencode: { background: '#59616B', ink: '#FFFFFF' },
};
export function getComposerAgentActionStyle(agent: string | null | undefined, label = ''): object | undefined {
    if (agent === undefined) return undefined;
    const brand = agent ? brands[agent] ?? brands.opencode : null;
    return { width: agent ? Math.max(110, label.length * 8 + 44) : 32, borderRadius: agent ? 11 : 16,
        ...(brand ? { backgroundColor: brand.background } : {}),
        transitionProperty: 'width, border-radius, background-color',
        transitionDuration: '380ms, 380ms, 220ms',
        transitionTimingFunction: 'cubic-bezier(.22,.8,.2,1)',
    };
}
const css = `
.paws-agent-action{position:absolute;inset:0;pointer-events:none}
.paws-agent-arrow{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:1;transform:scale(1) rotate(0deg);transition:opacity 160ms,transform 380ms cubic-bezier(.22,.8,.2,1)}
.paws-agent-new{position:absolute;inset:0;display:flex;align-items:center;gap:6px;padding-left:11px;padding-right:8px;white-space:nowrap;overflow:hidden;opacity:0;transform:translateX(-5px);transition:opacity 160ms,transform 380ms cubic-bezier(.22,.8,.2,1)}
.paws-agent-action[data-pending=true] .paws-agent-arrow{opacity:0;transform:scale(.65) rotate(35deg)}
.paws-agent-action[data-pending=true] .paws-agent-new{opacity:1;transform:translateX(0);transition-delay:80ms}
@media(prefers-reduced-motion:reduce){.paws-agent-action span,[data-testid=message-composer-action-surface],[data-testid=message-composer-new-session-surface]{transition:none!important}}
`;
export function ComposerAgentAction({ agent, label, fallback, busy }: ComposerAgentActionProps) {
    if (agent === undefined) return <>{fallback}</>;
    const brand = agent ? brands[agent] ?? brands.opencode : null;
    return <span className="paws-agent-action" data-pending={Boolean(agent)} aria-hidden="true">
        <style>{css}</style>
        <span className="paws-agent-arrow">{fallback}</span>
        <span className="paws-agent-new" style={{ color: brand?.ink, fontSize: 12, fontWeight: 600 }}>
            {busy ? fallback : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M19 13v5a2 2 0 0 1-2 2H8l-4 2V6a2 2 0 0 1 2-2h7m5-3v8m-4-4h8"/></svg>}
            <span>{label}</span>
        </span>
    </span>;
}
