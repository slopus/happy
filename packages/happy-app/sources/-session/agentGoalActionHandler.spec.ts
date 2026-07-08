import { describe, expect, it, vi } from 'vitest';
import { performAgentGoalAction } from './agentGoalActionHandler';

describe('performAgentGoalAction', () => {
    it('dispatches clear without an objective while tracking in-flight state', async () => {
        const dispatchGoalAction = vi.fn().mockResolvedValue(undefined);
        const setInFlight = vi.fn();

        await performAgentGoalAction({
            action: 'clear',
            currentGoalText: 'finish the branch',
            promptEditGoal: vi.fn(),
            dispatchGoalAction,
            setInFlight,
        });

        expect(dispatchGoalAction).toHaveBeenCalledTimes(1);
        expect(dispatchGoalAction).toHaveBeenCalledWith('clear', undefined);
        expect(setInFlight).toHaveBeenNthCalledWith(1, 'clear');
        expect(setInFlight).toHaveBeenNthCalledWith(2, null);
    });

    it('prompts for edit, trims the objective, and dispatches edit', async () => {
        const promptEditGoal = vi.fn().mockResolvedValue('  ship the parity fix  ');
        const dispatchGoalAction = vi.fn().mockResolvedValue(undefined);

        await performAgentGoalAction({
            action: 'edit',
            currentGoalText: 'finish the branch',
            promptEditGoal,
            dispatchGoalAction,
            setInFlight: vi.fn(),
        });

        expect(promptEditGoal).toHaveBeenCalledWith('finish the branch');
        expect(dispatchGoalAction).toHaveBeenCalledTimes(1);
        expect(dispatchGoalAction).toHaveBeenCalledWith('edit', 'ship the parity fix');
    });

    it.each([
        ['cancelled', null],
        ['blank', '   '],
        ['same value after trimming', '  finish the branch  '],
    ])('does not dispatch edit when the prompt is %s', async (_label, promptResult) => {
        const dispatchGoalAction = vi.fn();
        const setInFlight = vi.fn();

        await performAgentGoalAction({
            action: 'edit',
            currentGoalText: 'finish the branch',
            promptEditGoal: vi.fn().mockResolvedValue(promptResult),
            dispatchGoalAction,
            setInFlight,
        });

        expect(dispatchGoalAction).not.toHaveBeenCalled();
        expect(setInFlight).not.toHaveBeenCalled();
    });

    it('does nothing for stop before setting in-flight state', async () => {
        const promptEditGoal = vi.fn();
        const dispatchGoalAction = vi.fn();
        const setInFlight = vi.fn();

        await performAgentGoalAction({
            action: 'stop',
            currentGoalText: 'finish the branch',
            promptEditGoal,
            dispatchGoalAction,
            setInFlight,
        });

        expect(promptEditGoal).not.toHaveBeenCalled();
        expect(dispatchGoalAction).not.toHaveBeenCalled();
        expect(setInFlight).not.toHaveBeenCalled();
    });
});
