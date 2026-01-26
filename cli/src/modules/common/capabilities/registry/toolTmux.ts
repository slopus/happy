import type { Capability } from '../service';

export const tmuxCapability: Capability = {
    descriptor: { id: 'tool.tmux', kind: 'tool', title: 'tmux' },
    detect: async ({ context }) => {
        return context.cliSnapshot?.tmux ?? { available: false };
    },
};
