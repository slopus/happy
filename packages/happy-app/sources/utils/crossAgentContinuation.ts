import type { Machine, Session } from '@/sync/storageTypes';
import { isMachineOnline } from './machineUtils';

export function getCrossAgentTarget(session: Session, machine: Machine | null | undefined): 'claude' | 'codex' | null {
    const meta = session.metadata;
    if (!meta || meta.application || !meta.path || !meta.machineId || machine?.metadata?.crossAgentContinuation !== 1 || !isMachineOnline(machine)) return null;
    const state = session.agentState;
    const online = session.presence === 'online';
    if ((online && (session.thinking || state?.claudeThinking === true)) || (state?.turnStatus?.status === 'running' && (meta.flavor !== 'claude' || online)) || Object.keys(state?.requests ?? {}).length || (state?.queuedMessages ?? 0) > 0) return null;
    const target = meta.flavor === 'claude' && meta.claudeSessionId ? 'codex'
        : meta.flavor === 'codex' && meta.codexThreadId ? 'claude' : null;
    return target && machine.metadata.cliAvailability?.[target] === true ? target : null;
}
