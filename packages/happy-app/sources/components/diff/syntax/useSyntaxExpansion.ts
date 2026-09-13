import * as React from 'react';
import type { DiffFile } from '../engine/types';
import { planSyntax } from './plan';
import { SYNTAX_REVEAL_MS } from './protocol';
import { diffSyntax } from './shared';
import type { SyntaxService } from './service';

/** Keep existing rows painted while preparing an explicitly requested expansion. */
export function useSyntaxExpansion(file: DiffFile, enabled: boolean, onExpand: () => void, service: SyntaxService = diffSyntax) {
    const [waitingFor, setWaitingFor] = React.useState<DiffFile | null>(null);
    const active = React.useRef<{ cancel(): void } | null>(null);
    React.useEffect(() => {
        setWaitingFor(null);
        return () => { active.current?.cancel(); active.current = null; };
    }, [file]);

    const expand = React.useCallback(() => {
        if (active.current) return;
        const missing = enabled ? planSyntax(file, file.rows).filter((hunk) => !service.peek(hunk.key)) : [];
        if (!missing.length) { onExpand(); return; }
        const requests = missing.map((hunk) => service.request(hunk.input, 2, hunk.key));
        const started = performance.now();
        const finish = () => {
            if (active.current !== pending) return;
            active.current = null;
            clearTimeout(timer);
            setWaitingFor(null);
            onExpand();
            if (typeof __DEV__ !== 'undefined' && __DEV__) {
                console.log(`[perf] diff syntax expand wait=${(performance.now() - started).toFixed(1)}ms`);
            }
        };
        const timer = setTimeout(finish, SYNTAX_REVEAL_MS);
        const pending = {
            cancel: () => { clearTimeout(timer); for (const request of requests) request.cancel(); },
        };
        active.current = pending;
        setWaitingFor(file);
        void Promise.all(requests.map((request) => request.promise)).then(finish);
    }, [file, enabled, onExpand, service]);

    return { expand, busy: waitingFor === file };
}