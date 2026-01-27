import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';
import { checklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { createCapabilitiesService } from '@/capabilities/service';
import type { Capability } from '@/capabilities/service';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@/capabilities/types';
import { RPC_METHODS } from '@happy/protocol/rpc';

function titleCase(value: string): string {
    if (!value) return value;
    return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function createGenericCliCapability(agentId: AgentCatalogEntry['id']): Capability {
    return {
        descriptor: { id: `cli.${agentId}`, kind: 'cli', title: `${titleCase(agentId)} CLI` },
        detect: async ({ request, context }) => {
            const entry = context.cliSnapshot?.clis?.[agentId];
            return buildCliCapabilityData({ request, entry });
        },
    };
}

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerManager): void {
    let servicePromise: Promise<ReturnType<typeof createCapabilitiesService>> | null = null;

    const getService = (): Promise<ReturnType<typeof createCapabilitiesService>> => {
        if (servicePromise) return servicePromise;
        servicePromise = (async () => {
            const cliCapabilities = await Promise.all(
                (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
                    if (entry.getCliCapabilityOverride) {
                        return await entry.getCliCapabilityOverride();
                    }
                    return createGenericCliCapability(entry.id);
                }),
            );

            const extraCapabilitiesNested = await Promise.all(
                (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
                    if (!entry.getCapabilities) return [];
                    return [...(await entry.getCapabilities())];
                }),
            );
            const extraCapabilities: Capability[] = extraCapabilitiesNested.flat();

            return createCapabilitiesService({
                capabilities: [
                    ...cliCapabilities,
                    ...extraCapabilities,
                    tmuxCapability,
                ],
                checklists,
                buildContext: buildDetectContext,
            });
        })();
        return servicePromise;
    };

    rpcHandlerManager.registerHandler<{}, CapabilitiesDescribeResponse>(RPC_METHODS.CAPABILITIES_DESCRIBE, async () => {
        return (await getService()).describe();
    });

    rpcHandlerManager.registerHandler<CapabilitiesDetectRequest, CapabilitiesDetectResponse>(RPC_METHODS.CAPABILITIES_DETECT, async (data) => {
        return await (await getService()).detect(data);
    });

    rpcHandlerManager.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE, async (data) => {
        return await (await getService()).invoke(data);
    });
}
