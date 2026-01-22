import type { Capability } from '../service';
import { buildCliCapabilityData } from './cliBase';

export const cliCodexCapability: Capability = {
    descriptor: { id: 'cli.codex', kind: 'cli', title: 'Codex CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.codex;
        return buildCliCapabilityData({ request, name: 'codex', entry });
    },
};

