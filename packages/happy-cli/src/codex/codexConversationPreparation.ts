import type { CodexAppServerClient } from './codexAppServerClient';
import type { PreparedCodexDelegation } from './codexDelegationRpc';
import { resolveCodexExecutionPolicy } from './executionPolicy';

type PreparedThread = Pick<Awaited<ReturnType<CodexAppServerClient['prepareThreadConfiguration']>>, 'threadId' | 'model' | 'reasoningEffort'>;

/** Native acceptance is required before the shared metadata can advertise an applied configuration. */
export async function prepareCodexConversationConfiguration(configuration: PreparedCodexDelegation, deps: {
    client: Pick<CodexAppServerClient, 'sandboxEnabled'> & {
        prepareThreadConfiguration: (options: Parameters<CodexAppServerClient['prepareThreadConfiguration']>[0],
            assertCurrent: () => void) => Promise<PreparedThread>;
    };
    assertCurrent(): void;
    acknowledge(prepared: PreparedThread): Promise<void>;
}): Promise<void> {
    deps.assertCurrent();
    if (!configuration.effort) throw new Error('Codex reasoning effort must be resolved before preparation');
    const prepared = await deps.client.prepareThreadConfiguration({ model: configuration.model, effort: configuration.effort,
        ...resolveCodexExecutionPolicy(configuration.permissionMode, deps.client.sandboxEnabled) }, deps.assertCurrent);
    deps.assertCurrent();
    await deps.acknowledge(prepared);
    deps.assertCurrent();
}
