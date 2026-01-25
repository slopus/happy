import type { ChildProcess } from 'node:child_process';

type SignalForwardingProcess = Pick<NodeJS.Process, 'platform' | 'on' | 'off'>;

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

    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
        const handler = () => forwardSignal(signal);
        handlers.set(signal, handler);
        proc.on(signal, handler);
    }

    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        for (const [signal, handler] of handlers.entries()) {
            proc.off(signal, handler);
        }
    };

    child.on('exit', cleanup);
    child.on('close', cleanup);
    child.on('error', cleanup);
}

