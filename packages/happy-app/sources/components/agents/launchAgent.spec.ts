import { describe, it, expect, vi } from 'vitest';
import { launchAgent, type AgentLauncher } from './launchAgent';

const agent: AgentLauncher = {
    id: 'a1', name: '工作日程', glyph: '日', color: '#5e5791',
    machineId: 'm1', path: '~/work/schedule', kind: 'standard',
    spaceType: 'default',
    imageStyleIds: [],
    imageVariantsPerStyle: 1,
    presets: [],
};

describe('launchAgent', () => {
    it('sets machine before path and navigates with agentId', () => {
        const calls: string[] = [];
        const draft = {
            setMachineId: vi.fn(() => calls.push('machine')),
            setPath: vi.fn(() => calls.push('path')),
            setAgentType: vi.fn(() => calls.push('agent')),
            setSessionType: vi.fn(() => calls.push('type')),
            setInput: vi.fn(() => calls.push('input')),
            setPermissionMode: vi.fn(() => calls.push('permission')),
            setModelMode: vi.fn(() => calls.push('model')),
            setEffortLevel: vi.fn(() => calls.push('effort')),
        };
        const navigate = vi.fn();
        launchAgent(agent, draft as any, navigate);
        expect(calls.indexOf('machine')).toBeLessThan(calls.indexOf('path'));
        expect(draft.setMachineId).toHaveBeenCalledWith('m1');
        expect(draft.setPath).toHaveBeenCalledWith('~/work/schedule');
        expect(draft.setInput).toHaveBeenCalledWith('');
        expect(navigate).toHaveBeenCalledWith('/new?agentId=a1');
    });

    it('forces Codex for GPT Image 2 style generator agents', () => {
        const draft = {
            setMachineId: vi.fn(),
            setPath: vi.fn(),
            setAgentType: vi.fn(),
            setSessionType: vi.fn(),
            setInput: vi.fn(),
        };
        const navigate = vi.fn();

        launchAgent({ ...agent, kind: 'image-styles' }, draft as any, navigate);

        expect(draft.setAgentType).toHaveBeenCalledWith('codex');
    });

    it('applies optional runner defaults for built-in agents', () => {
        const draft = {
            setMachineId: vi.fn(),
            setPath: vi.fn(),
            setSessionType: vi.fn(),
            setInput: vi.fn(),
            setAgentType: vi.fn(),
            setPermissionMode: vi.fn(),
            setModelMode: vi.fn(),
            setEffortLevel: vi.fn(),
        };
        const navigate = vi.fn();
        launchAgent({
            ...agent,
            agentType: 'codex',
            permissionMode: 'yolo',
            modelMode: 'default',
            effortLevel: null,
        }, draft, navigate);

        expect(draft.setAgentType).toHaveBeenCalledWith('codex');
        expect(draft.setPermissionMode).toHaveBeenCalledWith('yolo');
        expect(draft.setModelMode).toHaveBeenCalledWith('default');
        expect(draft.setEffortLevel).toHaveBeenCalledWith(null);
    });

    it('opens the cloud relationship advisor without touching machine session draft', () => {
        const draft = {
            setMachineId: vi.fn(),
            setPath: vi.fn(),
            setSessionType: vi.fn(),
            setInput: vi.fn(),
            setAgentType: vi.fn(),
        };
        const navigate = vi.fn();

        launchAgent({ ...agent, runtime: 'relationship-advisor' }, draft, navigate);

        expect(draft.setMachineId).not.toHaveBeenCalled();
        expect(draft.setPath).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith('/relationship-advisor');
    });
});
