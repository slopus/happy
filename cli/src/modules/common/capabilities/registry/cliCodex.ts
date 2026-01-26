import type { Capability } from '../service';
import { buildCliCapabilityData } from '../probes/cliBase';
import { probeAcpAgentCapabilities } from '../probes/acpProbe';
import { DefaultTransport } from '@/agent/transport';
import { resolveCodexAcpCommand } from '@/codex/acp/resolveCodexAcpCommand';
import { normalizeCapabilityProbeError } from '../utils/normalizeCapabilityProbeError';

export const cliCodexCapability: Capability = {
    descriptor: { id: 'cli.codex', kind: 'cli', title: 'Codex CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.codex;
        const base = buildCliCapabilityData({ request, entry });

        const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
        if (!includeAcpCapabilities) {
            return base;
        }

        // Codex ACP is provided by the optional `codex-acp` binary (not the Codex CLI itself).
        // Probe initialize to check for loadSession support so the UI can enable resume reliably.
        const acp = await (async () => {
            try {
                const command = resolveCodexAcpCommand();
                const probe = await probeAcpAgentCapabilities({
                    command,
                    args: [],
                    cwd: process.cwd(),
                    env: {
                        NODE_ENV: 'production',
                        DEBUG: '',
                    },
                    transport: new DefaultTransport('codex'),
                    timeoutMs: 4000,
                });

                return probe.ok
                    ? { ok: true as const, checkedAt: probe.checkedAt, loadSession: probe.agentCapabilities?.loadSession === true }
                    : { ok: false as const, checkedAt: probe.checkedAt, error: normalizeCapabilityProbeError(probe.error) };
            } catch (e) {
                return { ok: false as const, checkedAt: Date.now(), error: normalizeCapabilityProbeError(e) };
            }
        })();

        return { ...base, acp };
    },
};
