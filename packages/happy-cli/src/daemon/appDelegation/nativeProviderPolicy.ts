/** Provider request constraints shared by initial launch, native resume and credential recovery. */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { nativeCodexMode, type NativeLaunchPolicy } from './nativeLaunchPolicy';
import { codexRestrictedConfig } from './restrictedCodex';
import { resolveCodexExecutionPolicy } from '@/codex/executionPolicy';

export function nativeCodexConfig(policy: NativeLaunchPolicy): Record<string, unknown> {
    const binding = policy.binding;
    const config = codexRestrictedConfig(binding.requestedModel, binding.reasoning, binding);
    // The existing audited account launcher owns provider routing and login.
    delete config.model_provider;
    delete config['model_providers.openai_http'];
    return config;
}
export function nativeCodexRequest(policy: NativeLaunchPolicy, method: string, input: Record<string, unknown>): Record<string, unknown> {
    const binding = policy.binding;
    const execution = resolveCodexExecutionPolicy(nativeCodexMode(policy).permissionMode, false);
    return { ...input, model: binding.requestedModel, approvalPolicy: execution.approvalPolicy,
        ...(method === 'turn/start' ? {
            effort: binding.reasoning.mode === 'explicit' ? binding.reasoning.value : null,
            sandboxPolicy: binding.permissionMode === 'yolo' ? { type: 'dangerFullAccess' } : { type: 'readOnly' },
        } : { sandbox: execution.sandbox, cwd: policy.directory,
            baseInstructions: policy.systemPrompt, developerInstructions: null,
            config: { ...(input.config as object ?? {}), ...nativeCodexConfig(policy), mcp_servers: {} },
            dynamicTools: [], selectedCapabilityRoots: [],
        }), environments: [], serviceTier: binding.serviceTier === 'fast' ? 'priority' : null };
}
export function nativeClaudeOptions(policy: NativeLaunchPolicy, executable: string): Partial<Options> {
    const binding = policy.binding;
    if (binding.engine !== 'claude' || binding.permissionMode === 'read-only' || binding.reasoning.mode === 'explicit' || binding.serviceTier === 'fast') throw new Error('parameter-unsupported');
    return {
        pathToClaudeCodeExecutable: executable,
        model: binding.requestedModel ?? undefined, fallbackModel: undefined, effort: undefined,
        systemPrompt: policy.systemPrompt,
        tools: binding.permissionMode === 'yolo' ? { type: 'preset', preset: 'claude_code' } : [],
        permissionMode: binding.permissionMode === 'yolo' ? 'bypassPermissions' : 'dontAsk',
        allowDangerouslySkipPermissions: binding.permissionMode === 'yolo',
        allowedTools: [], disallowedTools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], settings: undefined, plugins: [],
        extraArgs: { 'safe-mode': null, 'disable-slash-commands': null },
    };
}
