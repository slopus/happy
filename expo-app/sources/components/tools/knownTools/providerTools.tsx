import type { KnownToolDefinition } from './_types';
import { providerShellTools } from './providers/shell';
import { providerReasoningTools } from './providers/reasoning';
import { providerUiTools } from './providers/ui';
import { providerSearchTools } from './providers/search';
import { providerPatchTools } from './providers/patch';
import { providerDiffTools } from './providers/diff';
import { providerAskUserQuestionTools } from './providers/askUserQuestion';

export const knownToolsProviders = {
    ...providerShellTools,
    ...providerReasoningTools,
    ...providerUiTools,
    ...providerSearchTools,
    ...providerPatchTools,
    ...providerDiffTools,
    ...providerAskUserQuestionTools,
} satisfies Record<string, KnownToolDefinition>;
