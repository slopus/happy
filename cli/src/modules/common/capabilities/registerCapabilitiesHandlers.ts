import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { checklists } from './checklists';
import { buildDetectContext } from './context/buildDetectContext';
import { cliClaudeCapability } from './caps/cliClaude';
import { cliCodexCapability } from './caps/cliCodex';
import { cliGeminiCapability } from './caps/cliGemini';
import { codexMcpResumeDepCapability } from './caps/depCodexMcpResume';
import { tmuxCapability } from './caps/toolTmux';
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
            tmuxCapability,
            codexMcpResumeDepCapability,
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

