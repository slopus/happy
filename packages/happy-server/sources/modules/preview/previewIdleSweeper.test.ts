import { describe, expect, it, vi } from 'vitest';
import {
    startPreviewIdleSweeper,
    sweepIdlePreviewContainers,
    type DockerCommandRunner,
} from './previewIdleSweeper';

function dockerFrom(
    handler: (args: string[]) => { ok: boolean; stdout?: string; stderr?: string },
    calls: string[] = [],
): DockerCommandRunner {
    return async (args) => {
        calls.push(args.join(' '));
        const result = handler(args);
        return {
            ok: result.ok,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
        };
    };
}

describe('sweepIdlePreviewContainers', () => {
    it('stops only managed preview containers with stale access markers', async () => {
        const calls: string[] = [];
        const result = await sweepIdlePreviewContainers({
            now: () => 2_000_000,
            idleTimeoutMs: 600_000,
            docker: dockerFrom((args) => {
                if (args[0] === 'ps') return { ok: true, stdout: 'fresh\nstale\nmissing\n' };
                if (args[0] === 'exec' && args[1] === 'fresh') return { ok: true, stdout: '1600000' };
                if (args[0] === 'exec' && args[1] === 'stale') return { ok: true, stdout: '1300000' };
                if (args[0] === 'exec' && args[1] === 'missing') return { ok: true, stdout: '' };
                if (args[0] === 'stop') return { ok: true, stdout: args.slice(1).join('\n') };
                return { ok: false, stderr: 'unexpected' };
            }, calls),
        });

        expect(result).toEqual({
            ok: true,
            scannedContainerIds: ['fresh', 'stale', 'missing'],
            stoppedContainerIds: ['stale'],
        });
        expect(calls[0]).toBe(
            'ps -q --filter label=aplus.preview=true --filter label=aplus.managedBy=aplus-preview',
        );
        expect(calls).toContain('stop stale');
    });
});

describe('startPreviewIdleSweeper', () => {
    it('does not schedule when disabled', () => {
        const setIntervalFn = vi.fn();

        const controller = startPreviewIdleSweeper({
            enabled: false,
            setIntervalFn,
        });

        expect(controller).toBeNull();
        expect(setIntervalFn).not.toHaveBeenCalled();
    });

    it('skips overlapping interval ticks', async () => {
        let tick: (() => Promise<void>) | null = null;
        let resolveSweep: (() => void) | null = null;
        const sweep = vi.fn(() => new Promise<void>((resolve) => {
            resolveSweep = resolve;
        }));

        startPreviewIdleSweeper({
            enabled: true,
            intervalMs: 123,
            idleTimeoutMs: 456,
            sweep,
            setIntervalFn: (callback, ms) => {
                expect(ms).toBe(123);
                tick = callback;
                return { unref: vi.fn() } as never;
            },
            clearIntervalFn: vi.fn(),
        });

        const first = tick!();
        const second = tick!();
        expect(sweep).toHaveBeenCalledTimes(1);
        resolveSweep!();
        await Promise.all([first, second]);
    });
});
