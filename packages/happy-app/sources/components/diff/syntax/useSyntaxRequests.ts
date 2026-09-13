import * as React from 'react';
import { SYNTAX_REVEAL_MS, type SyntaxInput } from './protocol';
import { diffSyntax } from './shared';
import type { SyntaxOutcome, SyntaxRequest, SyntaxService } from './service';

export interface PlannedSyntax {
    key: string;
    input: SyntaxInput;
}

/** Shared first-reveal gate for diffs and terminal detail. No Prism on the UI thread. */
export function useSyntaxRequests(
    plan: readonly PlannedSyntax[],
    priority: number,
    service: SyntaxService = diffSyntax,
): { outcomes: Map<string, SyntaxOutcome>; pending: boolean } {
    const cached = React.useMemo(() => {
        const outcomes = new Map<string, SyntaxOutcome>();
        for (const part of plan) {
            const hit = service.peek(part.key);
            if (hit) outcomes.set(part.key, hit);
        }
        return outcomes;
    }, [plan, service]);
    const [settled, setSettled] = React.useState<{ plan: typeof plan; outcomes: Map<string, SyntaxOutcome> } | null>(null);
    const pendingSince = React.useRef<number | null>(null);
    const revealed = React.useRef(false);
    const requests = React.useRef<SyntaxRequest[]>([]);
    const priorityRef = React.useRef(priority);
    priorityRef.current = priority;

    React.useEffect(() => {
        for (const request of requests.current) request.setPriority(priority);
    }, [priority]);

    React.useEffect(() => {
        service.recordCacheUse(cached.size);
        if (cached.size === plan.length) {
            pendingSince.current = null;
            return;
        }
        let alive = true;
        let finished = false;
        const start = pendingSince.current ?? performance.now();
        pendingSince.current = start;
        const outcomes = new Map(cached);
        const finish = () => {
            if (!alive || finished) return;
            finished = true;
            pendingSince.current = null;
            // Freeze this paint. Late responses are cache-only, never a
            // recolor/reflow after the reader has already seen the content.
            setSettled({ plan, outcomes: new Map(outcomes) });
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.log(`[perf] syntax reveal wait=${(performance.now() - start).toFixed(1)}ms settled=${outcomes.size}/${plan.length}`);
            }
        };
        const remaining = Math.max(0, SYNTAX_REVEAL_MS - (performance.now() - start));
        const timer = setTimeout(finish, remaining);
        requests.current = plan.filter((part) => !cached.has(part.key)).map((part) => {
            const request = service.request(part.input, priorityRef.current, part.key);
            request.promise.then((outcome) => {
                if (!alive || finished) return;
                outcomes.set(part.key, outcome);
                if (outcomes.size === plan.length) finish();
            });
            return request;
        });
        // Streaming and expansion cannot blank content that has been painted.
        if (revealed.current) finish();
        return () => {
            alive = false;
            clearTimeout(timer);
            for (const request of requests.current) request.cancel();
            requests.current = [];
        };
    }, [plan, cached, service]);

    const outcomes = settled?.plan === plan ? settled.outcomes : cached;
    const pending = !revealed.current && plan.length > cached.size && settled?.plan !== plan;
    React.useLayoutEffect(() => { if (!pending && priority !== 0) revealed.current = true; }, [pending, priority]);
    return { outcomes, pending };
}