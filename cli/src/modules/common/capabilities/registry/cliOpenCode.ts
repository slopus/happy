import type { Capability } from '../service';
import { buildCliCapabilityData } from '../probes/cliBase';
import { probeAcpAgentCapabilities } from '../probes/acpProbe';
import { openCodeTransport } from '@/agent/transport';
import { normalizeCapabilityProbeError } from '../utils/normalizeCapabilityProbeError';
import { resolveAcpProbeTimeoutMs } from '../utils/acpProbeTimeout';

export const cliOpenCodeCapability: Capability = {
    descriptor: { id: 'cli.opencode', kind: 'cli', title: 'OpenCode CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.opencode;
        const base = buildCliCapabilityData({ request, entry });

        const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
        if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
            return base;
        }

        const probe = await probeAcpAgentCapabilities({
            command: base.resolvedPath,
            args: ['acp'],
            cwd: process.cwd(),
            env: {
                // Keep output clean to avoid ACP stdout pollution.
                NODE_ENV: 'production',
                DEBUG: '',
            },
            transport: openCodeTransport,
            timeoutMs: resolveAcpProbeTimeoutMs('opencode'),
        });

        const acp = probe.ok
            ? { ok: true, checkedAt: probe.checkedAt, loadSession: probe.agentCapabilities?.loadSession === true }
            : { ok: false, checkedAt: probe.checkedAt, error: normalizeCapabilityProbeError(probe.error) };

        return { ...base, acp };
    },
};
