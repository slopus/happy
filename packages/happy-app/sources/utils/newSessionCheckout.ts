import type { StartSessionOverrides } from '@/hooks/useStartSessionFromDraft';
import type { Session } from '@/sync/storageTypes';
import type { NewSessionAgentType } from '@/sync/persistence';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { getRigReasoningSelection, getRigSelectedModelKey, isRigMetadata } from '@/sync/rig';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';

const AGENT_TYPES: readonly NewSessionAgentType[] = ['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'agy', 'rig'];

function agentTypeOf(session: Session): NewSessionAgentType {
    if (isRigMetadata(session.metadata)) return 'rig';
    const flavor = session.metadata?.flavor;
    return AGENT_TYPES.find((candidate) => candidate === flavor) ?? 'claude';
}

/**
 * Another chat exactly where this one runs, started the same way.
 *
 * The directory is the chat's own, not its project's: a chat opened in a
 * worktree gets a sibling in that worktree, which is the whole point of asking
 * from inside a checkout. That also settles the destination outright, so none
 * of the composer's worktree machinery — which exists to *pick* or create one —
 * is involved.
 *
 * Happy Agent is told the catalog project or workspace rather than the path.
 * Its workspaces are identities and not directories, and handing it a directory
 * it already owns invites a duplicate project.
 *
 * The model, permission and effort keys are the chat's own picks. A key the
 * machine no longer offers is not an error: the start resolves each against what
 * the agent actually supports and falls back to the default.
 */
export function newSessionLikeSession(session: Session): StartSessionOverrides {
    const metadata = session.metadata;
    const path = metadata?.path?.trim() || '';
    const rig = isRigMetadata(metadata);
    // Rig keeps the live pick in its metadata and only mirrors it onto the
    // session once something changes it, so the mirror cannot be read alone.
    const modelMode = session.modelMode ?? (rig ? getRigSelectedModelKey(metadata) : null);
    const permissionMode = session.permissionMode
        ?? (rig
            ? metadata?.currentOperatingModeCode ?? metadata?.permissionMode ?? metadata?.session?.permissionMode
            : null);

    return {
        selectedMachineId: metadata?.machineId ?? null,
        selectedPath: path ? formatPathRelativeToHome(path, metadata?.homeDir ?? undefined) : null,
        sessionType: 'simple',
        worktreeKey: null,
        agentType: agentTypeOf(session),
        permissionMode: (permissionMode ?? null) as PermissionModeKey | null,
        modelMode,
        effortLevel: session.effortLevel ?? (rig ? getRigReasoningSelection(metadata, modelMode) : null),
        happyAgentTarget: rig
            ? metadata?.workspace?.id
                ? { kind: 'workspace', id: metadata.workspace.id }
                : metadata?.project?.id
                    ? { kind: 'project', id: metadata.project.id }
                    : null
            : null,
        // Nothing was typed for this session, and the composer's draft belongs to
        // whatever the user is writing elsewhere.
        input: '',
        attachments: [],
    };
}
