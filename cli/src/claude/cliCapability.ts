import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';

export const cliCapability: Capability = {
    descriptor: { id: 'cli.claude', kind: 'cli', title: 'Claude CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.claude;
        return buildCliCapabilityData({ request, entry });
    },
};
