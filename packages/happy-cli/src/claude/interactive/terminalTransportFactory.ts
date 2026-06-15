import { isTmuxAvailable } from '@/utils/tmux';
import { PtyTerminalTransport } from './ptyTerminalTransport';
import { sanitizeTmuxClientEnvironment } from './terminalEnvironment';
import { TmuxTerminalTransport } from './tmuxTerminalTransport';
import {
    chooseTerminalBackend,
    type TerminalTransport,
} from './terminalTransport';

export async function createTerminalTransport(env: NodeJS.ProcessEnv = process.env): Promise<TerminalTransport | null> {
    const tmuxSessionName = typeof env.TMUX_SESSION_NAME === 'string' && env.TMUX_SESSION_NAME.trim().length > 0
        ? env.TMUX_SESSION_NAME.trim()
        : null;
    const tmuxAvailable = tmuxSessionName === null
        ? false
        : await isTmuxAvailable(sanitizeTmuxClientEnvironment(env));
    const backend = chooseTerminalBackend({
        tmuxConfigured: tmuxSessionName !== null,
        tmuxAvailable,
        ptyAvailable: process.platform !== 'win32',
    });

    switch (backend) {
        case 'tmux':
            return new TmuxTerminalTransport(tmuxSessionName!);
        case 'pty':
            return new PtyTerminalTransport();
        case 'unsupported':
            return null;
        default: {
            const _: never = backend satisfies never;
            return _;
        }
    }
}
