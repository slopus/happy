import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { checklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { cliClaudeCapability } from '@/capabilities/registry/cliClaude';
import { cliCodexCapability } from '@/capabilities/registry/cliCodex';
import { cliGeminiCapability } from '@/capabilities/registry/cliGemini';
import { cliOpenCodeCapability } from '@/capabilities/registry/cliOpenCode';
import { codexAcpDepCapability } from '@/capabilities/registry/depCodexAcp';
import { codexMcpResumeDepCapability } from '@/capabilities/registry/depCodexMcpResume';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { createCapabilitiesService } from '@/capabilities/service';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@/capabilities/types';

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerManager): void {
    const service = createCapabilitiesService({
        capabilities: [
            cliCodexCapability,
            cliClaudeCapability,
            cliGeminiCapability,
            cliOpenCodeCapability,
            tmuxCapability,
            codexMcpResumeDepCapability,
            codexAcpDepCapability,
        ],
        checklists,
        buildContext: buildDetectContext,
    });

    rpcHandlerManager.registerHandler<{}, CapabilitiesDescribeResponse>('capabilities.describe', async () => {
        return service.describe();
    });

    rpcHandlerManager.registerHandler<CapabilitiesDetectRequest, CapabilitiesDetectResponse>('capabilities.detect', async (data) => {
        return await service.detect(data);
    });

    rpcHandlerManager.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>('capabilities.invoke', async (data) => {
        return await service.invoke(data);
    });
}
