import * as React from 'react';
import type { DiffFile, DiffRow } from '../engine/types';
import { applySyntax, planSyntax } from './plan';
import { diffSyntax } from './shared';
import type { SyntaxService } from './service';
import { useSyntaxRequests } from './useSyntaxRequests';

/** 0 = measurement/disabled, 1 = mounted ahead/prefetched, 2 = actually visible. */
export const DiffSyntaxPriority = React.createContext(2);
/** Allows the dev benchmark to compare against a genuinely syntax-free render. */
export const DiffSyntaxEnabled = React.createContext(true);

export function usePreparedSyntax(
    file: DiffFile,
    displayed: DiffRow[],
    priority: number,
    service: SyntaxService = diffSyntax,
): { rows: DiffRow[]; pending: boolean } {
    const plan = React.useMemo(() => priority === 0 ? [] : planSyntax(file, displayed), [file, displayed, priority === 0]);
    const { outcomes, pending } = useSyntaxRequests(plan, priority, service);
    const rows = React.useMemo(() => {
        if (!outcomes.size) return displayed;
        const start = performance.now();
        const result = applySyntax(displayed, plan, outcomes);
        const elapsed = performance.now() - start;
        if (elapsed > 2 || (typeof __DEV__ !== 'undefined' && __DEV__)) {
            console.log(`[perf] diff syntax apply=${elapsed.toFixed(1)}ms rows=${displayed.length}`);
        }
        return result;
    }, [displayed, plan, outcomes]);
    return { rows, pending };
}