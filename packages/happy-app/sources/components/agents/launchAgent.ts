import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { NewSessionAgentType, NewSessionSessionType } from '@/sync/persistence';

export interface AgentPreset { label: string; prompt: string; }
export interface AgentLauncher {
    id: string; name: string; glyph: string; color: string;
    machineId: string; path: string; presets: AgentPreset[];
    kind: 'standard' | 'image-styles';
    spaceType: 'default' | 'health';
    imageStyleIds: string[];
    imageVariantsPerStyle: number;
    agentType?: NewSessionAgentType;
    permissionMode?: PermissionModeKey;
    modelMode?: string;
    effortLevel?: string | null;
    runtime?: 'relationship-advisor';
    builtin?: boolean;
}

export function resolveAgentTypeForLaunch(agent: AgentLauncher): NewSessionAgentType | undefined {
    return agent.agentType ?? (agent.kind === 'image-styles' ? 'codex' : undefined);
}

interface DraftSetters {
    setMachineId: (id: string | null) => void;
    setPath: (path: string | null) => void;
    setAgentType: (agent: NewSessionAgentType) => void;
    setSessionType: (t: NewSessionSessionType) => void;
    setInput: (s: string) => void;
    setPermissionMode?: (mode: PermissionModeKey) => void;
    setModelMode?: (mode: string) => void;
    setEffortLevel?: (level: string | null) => void;
}

/**
 * 设 draft（顺序：先 machine 后 path，因 setMachineId 会清空 path）后导航到预填的新建会话页。
 * `initialInput` 用于「空间模式」里点预设快捷指令时预填提示词；缺省清空输入。
 */
export function launchAgent(
    agent: AgentLauncher,
    draft: DraftSetters,
    navigate: (path: string) => void,
    options?: { initialInput?: string },
): void {
    if (agent.runtime === 'relationship-advisor') {
        navigate('/relationship-advisor');
        return;
    }
    draft.setMachineId(agent.machineId);
    draft.setPath(agent.path);
    const agentType = resolveAgentTypeForLaunch(agent);
    if (agentType) draft.setAgentType(agentType);
    if (agent.permissionMode) draft.setPermissionMode?.(agent.permissionMode);
    if (agent.modelMode) draft.setModelMode?.(agent.modelMode);
    if (agent.effortLevel !== undefined) draft.setEffortLevel?.(agent.effortLevel);
    draft.setSessionType('simple');
    draft.setInput(options?.initialInput ?? '');
    navigate(`/new?agentId=${agent.id}`);
}
