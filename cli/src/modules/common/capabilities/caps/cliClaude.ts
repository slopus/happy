import type { Capability } from '../service';
import { buildCliCapabilityData } from './cliBase';

export const cliClaudeCapability: Capability = {
    descriptor: { id: 'cli.claude', kind: 'cli', title: 'Claude CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.claude;
        return buildCliCapabilityData({ request, name: 'claude', entry });
    },
};

