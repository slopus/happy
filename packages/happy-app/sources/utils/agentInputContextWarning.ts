import { t } from '@/text';

export const AGENT_INPUT_CONTEXT_MAX = 190000;

type ContextWarningTheme = {
    colors: {
        warning: string;
        warningCritical: string;
    };
};

export type AgentInputUsageData = {
    contextSize: number;
    contextWindow?: number;
};

export type AgentInputContextWarning = {
    text: string;
    color: string;
};

export function getContextWarning(
    contextSize: number,
    alwaysShow: boolean = false,
    theme: ContextWarningTheme,
    contextWindow: number = AGENT_INPUT_CONTEXT_MAX,
): AgentInputContextWarning | null {
    const maxContextSize = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : AGENT_INPUT_CONTEXT_MAX;
    const percentageUsed = (contextSize / maxContextSize) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null;
}

export function resolveAgentInputContextWarning(
    usageData: AgentInputUsageData | undefined,
    alwaysShow: boolean,
    theme: ContextWarningTheme,
): AgentInputContextWarning | null {
    return alwaysShow || usageData?.contextSize
        ? getContextWarning(usageData?.contextSize ?? 0, alwaysShow, theme, usageData?.contextWindow)
        : null;
}
