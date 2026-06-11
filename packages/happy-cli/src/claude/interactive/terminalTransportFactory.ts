import { isTmuxAvailable } from '@/utils/tmux';
import { PtyTerminalTransport } from './ptyTerminalTransport';
import { TmuxTerminalTransport } from './tmuxTerminalTransport';
import {
    chooseTerminalBackend,
    type TerminalTransport,
} from './terminalTransport';

export async function createTerminalTransport(env: NodeJS.ProcessEnv = process.env): Promise<TerminalTransport | null> {
    const backend = chooseTerminalBackend({
        tmuxConfigured: env.TMUX_SESSION_NAME !== undefined,
        tmuxAvailable: await isTmuxAvailable(),
        ptyAvailable: process.platform !== 'win32',
    });

    switch (backend) {
        case 'tmux':
            return new TmuxTerminalTransport(env.TMUX_SESSION_NAME ?? '');
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
