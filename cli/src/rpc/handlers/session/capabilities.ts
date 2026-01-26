import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { checklists } from '@/modules/common/capabilities/checklists';
import { buildDetectContext } from '@/modules/common/capabilities/context/buildDetectContext';
import { cliClaudeCapability } from '@/modules/common/capabilities/registry/cliClaude';
import { cliCodexCapability } from '@/modules/common/capabilities/registry/cliCodex';
import { cliGeminiCapability } from '@/modules/common/capabilities/registry/cliGemini';
import { cliOpenCodeCapability } from '@/modules/common/capabilities/registry/cliOpenCode';
import { codexAcpDepCapability } from '@/modules/common/capabilities/registry/depCodexAcp';
import { codexMcpResumeDepCapability } from '@/modules/common/capabilities/registry/depCodexMcpResume';
import { tmuxCapability } from '@/modules/common/capabilities/registry/toolTmux';
import { createCapabilitiesService } from '@/modules/common/capabilities/service';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@/modules/common/capabilities/types';

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
