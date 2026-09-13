import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiffFromPatch } from '../engine/buildDiff';
import type { DiffFile, DiffRow } from '../engine/types';
import { SyntaxService } from './service';
import type { SyntaxInput, SyntaxResult } from './protocol';
import { tokenize } from './tokenize';
import { usePreparedSyntax } from './usePreparedSyntax';

vi.mock('./shared', () => ({ diffSyntax: {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fileFor = (name: string) => buildDiffFromPatch(`--- a/sample.ts\n+++ b/sample.ts\n@@ -0,0 +1 @@\n+const ${name} = 1;`).files[0];
const colored = (rows: DiffRow[]) => rows.some((row) => row.kind === 'line' && row.spans.some((span) => span.k === 'keyword'));

function setup(file: DiffFile, priority = 2) {
    const jobs: { input: SyntaxInput; resolve: (result: SyntaxResult) => void }[] = [];
    const run = vi.fn((input: SyntaxInput) => new Promise<SyntaxResult>((resolve) => jobs.push({ input, resolve })));
    const service = new SyntaxService({ run }, () => {});
    let state!: ReturnType<typeof usePreparedSyntax>;
    const Probe = ({ value, importance }: { value: DiffFile; importance: number }) => {
        state = usePreparedSyntax(value, value.rows, importance, service);
        return null;
    };
    let renderer: ReturnType<typeof create>;
    const mount = () => act(() => { renderer = create(React.createElement(Probe, { value: file, importance: priority })); });
    mount();
    return {
        service, run, jobs,
        state: () => state,
        tick: async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); },
        finish: async (index: number) => { await act(async () => { jobs[index].resolve(tokenize(jobs[index].input)); }); },
        update: (value: DiffFile, importance = priority) => act(() => renderer.update(React.createElement(Probe, { value, importance }))),
        unmount: () => act(() => renderer.unmount()),
        mount,
    };
}

describe('one-second first-paint syntax gate', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it('holds the first visible paint for syntax and then reveals it once', async () => {
        const probe = setup(fileFor('first'));
        expect(probe.state().pending).toBe(true);
        await probe.tick(100);
        expect(probe.state().pending).toBe(true);
        await probe.finish(0);
        expect(probe.state().pending).toBe(false);
        expect(colored(probe.state().rows)).toBe(true);
        probe.unmount();
    });

    it('reveals plain at exactly one second, freezes that paint, and caches late colors for remount', async () => {
        const probe = setup(fileFor('timeout'));
        await probe.tick(999);
        expect(probe.state().pending).toBe(true);
        await probe.tick(1);
        expect(probe.state().pending).toBe(false);
        expect(colored(probe.state().rows)).toBe(false);
        const rows = probe.state().rows;
        await probe.finish(0);
        expect(probe.state().rows).toBe(rows);
        probe.unmount();
        probe.mount();
        expect(probe.state().pending).toBe(false);
        expect(colored(probe.state().rows)).toBe(true);
        expect(probe.run).toHaveBeenCalledTimes(1);
        probe.unmount();
    });

    it('does not restart the deadline as streaming supplies newer content', async () => {
        const probe = setup(fileFor('old'));
        await probe.tick(600);
        probe.update(fileFor('new'));
        await probe.tick(399);
        expect(probe.state().pending).toBe(true);
        await probe.tick(1);
        expect(probe.state().pending).toBe(false);
        expect(probe.state().rows.some((row) => row.kind === 'line' && row.text.includes('new'))).toBe(true);
        probe.unmount();
    });

    it('discards stale results and never blanks already painted content on updates', async () => {
        const probe = setup(fileFor('old'));
        await probe.tick(1);
        probe.update(fileFor('new'));
        await probe.finish(0);
        expect(probe.state().pending).toBe(true);
        expect(colored(probe.state().rows)).toBe(false);
        await probe.tick(1);
        await probe.finish(1);
        expect(colored(probe.state().rows)).toBe(true);
        probe.update(fileFor('newest'));
        expect(probe.state().pending).toBe(false);
        expect(colored(probe.state().rows)).toBe(false);
        await probe.tick(1);
        await probe.finish(2);
        expect(colored(probe.state().rows)).toBe(false);
        probe.unmount();
    });

    it('does no work for measurement cells and starts when actually mounted', async () => {
        const file = fileFor('measured');
        const probe = setup(file, 0);
        await probe.tick(100);
        expect(probe.run).not.toHaveBeenCalled();
        expect(probe.state().pending).toBe(false);
        probe.update(file, 1);
        expect(probe.state().pending).toBe(true);
        await probe.tick(1);
        expect(probe.run).toHaveBeenCalledTimes(1);
        probe.unmount();
    });

    it('prepares an unfocused prefetched cell without blanking it when focused', async () => {
        const file = fileFor('prefetched');
        const probe = setup(file, 1);
        await probe.tick(1);
        await probe.finish(0);
        expect(probe.state().pending).toBe(false);
        expect(colored(probe.state().rows)).toBe(true);
        const painted = probe.state().rows;
        probe.update(file, 2);
        expect(probe.state().pending).toBe(false);
        expect(probe.state().rows).toBe(painted);
        expect(probe.run).toHaveBeenCalledTimes(1);
        probe.unmount();
    });
});