import type { ChildProcess } from 'node:child_process';

type SignalForwardingProcess = Pick<NodeJS.Process, 'platform' | 'on' | 'off' | 'pid' | 'kill'>;

export function attachProcessSignalForwardingToChild(
    child: ChildProcess,
    proc: SignalForwardingProcess = process,
): void {
    const forwardSignal = (signal: NodeJS.Signals) => {
        if (child.pid && !child.killed) {
            child.kill(signal);
        }
    };

    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    if (proc.platform !== 'win32') {
        signals.push('SIGHUP');
    }

    let cleanedUp = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        for (const [signal, handler] of handlers.entries()) {
            proc.off(signal, handler);
        }
    };

    for (const signal of signals) {
        const handler = () => {
            forwardSignal(signal);
            cleanup();
            try {
                proc.kill(proc.pid, signal);
            } catch {
                // ignore
            }
        };
        handlers.set(signal, handler);
        proc.on(signal, handler);
    }

    child.on('exit', cleanup);
    child.on('close', cleanup);
    child.on('error', cleanup);
}
