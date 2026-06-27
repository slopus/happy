import type { AgentGoalAction } from '@/components/AgentGoalBar';

type PerformAgentGoalActionOptions = {
    action: AgentGoalAction;
    currentGoalText: string;
    promptEditGoal: (currentGoalText: string) => Promise<string | null | undefined>;
    dispatchGoalAction: (action: AgentGoalAction, objective?: string) => Promise<void>;
    setInFlight: (action: AgentGoalAction | null) => void;
    onError?: (error: unknown) => void;
};

export async function performAgentGoalAction({
    action,
    currentGoalText,
    promptEditGoal,
    dispatchGoalAction,
    setInFlight,
    onError,
}: PerformAgentGoalActionOptions): Promise<void> {
    if (action === 'stop') {
        return;
    }

    let objective: string | undefined;
    if (action === 'edit') {
        const nextGoal = await promptEditGoal(currentGoalText);
        const trimmedGoal = nextGoal?.trim();
        if (!trimmedGoal || trimmedGoal === currentGoalText.trim()) {
            return;
        }
        objective = trimmedGoal;
    }

    setInFlight(action);
    try {
        await dispatchGoalAction(action, objective);
    } catch (error) {
        onError?.(error);
    } finally {
        setInFlight(null);
    }
}
