import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiffFromPatch } from '../engine/buildDiff';
import { SyntaxService } from './service';
import { usePreparedSyntax } from './usePreparedSyntax';
import { useSyntaxExpansion } from './useSyntaxExpansion';
import { tokenize } from './tokenize';
import type { SyntaxInput, SyntaxResult } from './protocol';

vi.mock('./shared', () => ({ diffSyntax: {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = buildDiffFromPatch('--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+const first = 1;\n@@ -9,0 +10 @@\n+const second = 2;').files[0];

async function setup() {
    const jobs: { input: SyntaxInput; resolve: (result: SyntaxResult) => void }[] = [];
    const service = new SyntaxService({ run: (input) => new Promise((resolve) => jobs.push({ input, resolve })) }, () => {});
    let expansion!: ReturnType<typeof useSyntaxExpansion>;
    let prepared!: ReturnType<typeof usePreparedSyntax>;
    let expanded = false;
    const Probe = () => {
        const [all, setAll] = React.useState(false);
        expanded = all;
        const reveal = React.useCallback(() => setAll(true), []);
        expansion = useSyntaxExpansion(file, true, reveal, service);
        const displayed = React.useMemo(() => all ? file.rows : file.rows.slice(0, 2), [all]);
        prepared = usePreparedSyntax(file, displayed, 2, service);
        return null;
    };
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(Probe)); });
    const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const finish = async (i: number) => { await act(async () => { jobs[i].resolve(tokenize(jobs[i].input)); }); };
    await tick(1);
    await finish(0);
    return {
        tick, finish, jobs, service,
        press: () => act(() => expansion.expand()),
        state: () => ({ expanded, busy: expansion.busy, ...prepared }),
        unmount: () => act(() => renderer.unmount()),
    };
}

describe('show-more syntax admission', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
    afterEach(() => vi.useRealTimers());

    it('keeps existing rows visible, ignores repeat taps, then expands with colors', async () => {
        const probe = await setup();
        const previous = probe.state().rows;
        probe.press();
        probe.press();
        expect(probe.state()).toMatchObject({ expanded: false, busy: true, pending: false });
        expect(probe.state().rows).toBe(previous);
        await probe.tick(1);
        expect(probe.jobs).toHaveLength(2);
        await probe.finish(1);
        expect(probe.state()).toMatchObject({ expanded: true, busy: false, pending: false });
        const second = probe.state().rows[3];
        expect(second.kind === 'line' && second.spans.some((span) => span.k === 'keyword')).toBe(true);
        probe.press();
        expect(probe.state().busy).toBe(false);
        expect(probe.jobs).toHaveLength(2);
        probe.unmount();
    });

    it('expands plain after one second and cancels queued work on unmount', async () => {
        const probe = await setup();
        probe.press();
        await probe.tick(999);
        expect(probe.state().busy).toBe(true);
        await probe.tick(1);
        expect(probe.state()).toMatchObject({ expanded: true, busy: false, pending: false });
        const second = probe.state().rows[3];
        expect(second.kind === 'line' && second.spans.every((span) => span.k === 'plain')).toBe(true);
        probe.unmount();
        expect(probe.service.getStats().queued).toBe(0);
    });

    it('cancels an expansion before queued work starts', async () => {
        const probe = await setup();
        probe.press();
        expect(probe.state().busy).toBe(true);
        probe.unmount();
        await probe.tick(1);
        expect(probe.service.getStats().queued).toBe(0);
        expect(probe.jobs).toHaveLength(1);
    });
});