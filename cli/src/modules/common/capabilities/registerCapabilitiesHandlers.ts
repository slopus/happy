import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { checklists } from './checklists';
import { buildDetectContext } from './context/buildDetectContext';
import { cliClaudeCapability } from './registry/cliClaude';
import { cliCodexCapability } from './registry/cliCodex';
import { cliGeminiCapability } from './registry/cliGemini';
import { cliOpenCodeCapability } from './registry/cliOpenCode';
import { codexAcpDepCapability } from './registry/depCodexAcp';
import { codexMcpResumeDepCapability } from './registry/depCodexMcpResume';
import { tmuxCapability } from './registry/toolTmux';
import { createCapabilitiesService } from './service';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from './types';

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
