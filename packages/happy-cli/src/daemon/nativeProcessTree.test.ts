import { describe, expect, it } from 'vitest';
import { nativeProcessTreeFromTable, nativeProcessTreeHasExited, sameNativeProcessTree } from './nativeProcessTree';

const before = '100 1 100 Sun Nov 29 01:00:00 2026\n101 100 100 Sun Nov 29 01:00:01 2026\n102 101 102 Sun Nov 29 01:00:02 2026\n900 1 900 Sun Nov 29 00:00:00 2026';
// Linux kernel processes may legitimately appear in the full ps table with PGID 0.
const unrelatedLinuxProcesses = '2 0 0 Sun Nov 29 00:00:00 2026\n3 2 0 Sun Nov 29 00:00:00 2026';
describe('authenticated candidate process lifetime evidence', () => {
    it('captures and observes the authenticated subtree despite unrelated Linux PGID-zero processes', () => {
        const tree = nativeProcessTreeFromTable(100, before + '\n' + unrelatedLinuxProcesses);
        expect(tree).toEqual(nativeProcessTreeFromTable(100, before));
        expect(nativeProcessTreeHasExited(tree, before + '\n' + unrelatedLinuxProcesses)).toBe(false);
        expect(nativeProcessTreeHasExited(tree, unrelatedLinuxProcesses)).toBe(true);
    });
    it.each([
        before.replace('100 1 100', '100 1 0'),
        before.replace('102 101 102', '102 101 0'),
    ])('refuses PGID-zero lifetimes in the captured subtree', table => {
        expect(() => nativeProcessTreeFromTable(100, table)).toThrow();
    });
    it.each([
        before.replace('100 1 100', '100 1 0'),
        before.replace('102 101 102', '102 101 0'),
        before + '\n103 101 0 Sun Nov 29 01:00:05 2026',
    ])('keeps PGID-zero captured or new descendant observations unconfirmed', table => {
        const tree = nativeProcessTreeFromTable(100, before);
        expect(() => nativeProcessTreeHasExited(tree, table)).toThrow();
    });
    it('captures only the full observed descendant subtree, including independently grouped sidecars', () => {
        const tree = nativeProcessTreeFromTable(100, before);
        expect(tree.processes.map(process => [process.pid, process.pgid])).toEqual([[100, 100], [101, 100], [102, 102]]);
    });
    it('does not call reparenting or exec of a captured lifetime an exit', () => {
        const tree = nativeProcessTreeFromTable(100, before);
        expect(nativeProcessTreeHasExited(tree, '102 1 102 Sun Nov 29 01:00:02 2026\n900 1 900 Sun Nov 29 00:00:00 2026')).toBe(false);
    });
    it('recognizes an ended child lifetime without waiting for an unrelated reuse of its numeric PID', () => {
        const tree = nativeProcessTreeFromTable(100, before);
        expect(nativeProcessTreeHasExited(tree, '102 1 102 Sun Nov 29 01:00:04 2026\n900 1 900 Sun Nov 29 00:00:00 2026')).toBe(true);
    });
    it('refuses a reused host PID and an unobserved new sidecar', () => {
        const tree = nativeProcessTreeFromTable(100, before);
        expect(() => nativeProcessTreeHasExited(tree, before.replace('100 1 100 Sun Nov 29 01:00:00', '100 1 100 Sun Nov 29 01:00:04'))).toThrow(/reused/);
        expect(() => nativeProcessTreeHasExited(tree, before + '\n103 101 103 Sun Nov 29 01:00:05 2026')).toThrow(/descendant/);
    });
    it('detects a changed subtree before effect but tolerates daemon-restart reparenting of the same host lifetime', () => {
        const tree = nativeProcessTreeFromTable(100, before);
        expect(sameNativeProcessTree(tree, nativeProcessTreeFromTable(100, before.replace('100 1 100', '100 42 100')))).toBe(true);
        expect(sameNativeProcessTree(tree, nativeProcessTreeFromTable(100, before + '\n103 101 103 Sun Nov 29 01:00:05 2026'))).toBe(false);
    });
    it.each(['', '100 1 100 unknown', before + '\ninvalid', before + '\n100 1 100 Sun Nov 29 01:00:00 2026'])('rejects incomplete or ambiguous process evidence', table => {
        expect(() => nativeProcessTreeFromTable(100, table)).toThrow();
    });
});
