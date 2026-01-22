import type { Capability } from '../service';
import { buildCliCapabilityData } from './cliBase';

export const cliGeminiCapability: Capability = {
    descriptor: { id: 'cli.gemini', kind: 'cli', title: 'Gemini CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.gemini;
        return buildCliCapabilityData({ request, name: 'gemini', entry });
    },
};

