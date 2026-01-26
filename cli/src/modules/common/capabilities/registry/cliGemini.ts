import type { Capability } from '../service';
import { buildCliCapabilityData } from '../probes/cliBase';
import { probeAcpAgentCapabilities } from '../probes/acpProbe';
import { geminiTransport } from '@/agent/transport';
import { normalizeCapabilityProbeError } from '../utils/normalizeCapabilityProbeError';

export const cliGeminiCapability: Capability = {
    descriptor: { id: 'cli.gemini', kind: 'cli', title: 'Gemini CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.gemini;
        const base = buildCliCapabilityData({ request, entry });

        const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
        if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
            return base;
        }

        const probe = await probeAcpAgentCapabilities({
            command: base.resolvedPath,
            args: ['--experimental-acp'],
            cwd: process.cwd(),
            env: {
                // Keep output clean to avoid ACP stdout pollution.
                NODE_ENV: 'production',
                DEBUG: '',
            },
            transport: geminiTransport,
            timeoutMs: 4000,
        });

        const acp = probe.ok
            ? { ok: true, checkedAt: probe.checkedAt, loadSession: probe.agentCapabilities?.loadSession === true }
            : { ok: false, checkedAt: probe.checkedAt, error: normalizeCapabilityProbeError(probe.error) };

        return { ...base, acp };
    },
};
