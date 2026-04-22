import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { Session } from './storageTypes';

type SessionLocalFields = Pick<Session, 'draft' | 'permissionMode' | 'modelMode' | 'effortLevel' | 'metadata'>;

type ResolveSessionLocalStateParams = {
    session: SessionLocalFields;
    existingSession?: SessionLocalFields | null;
    savedDraft?: string;
    savedPermissionMode?: string;
    savedModelMode?: string;
    savedEffortLevel?: string;
};

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

function pickNonDefaultMode(...values: Array<string | null | undefined>): string | undefined {
    for (const value of values) {
        if (value && value !== 'default') {
            return value;
        }
    }
    return undefined;
}

function pickDefinedValue(...values: Array<string | null | undefined>): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

export function resolveSessionLocalState({
    session,
    existingSession,
    savedDraft,
    savedPermissionMode,
    savedModelMode,
    savedEffortLevel,
}: ResolveSessionLocalStateParams): {
    draft: string | null;
    permissionMode: PermissionModeKey;
    modelMode?: string;
    effortLevel?: string;
} {
    const defaultPermissionMode: PermissionModeKey = isSandboxEnabled(session.metadata) ? 'bypassPermissions' : 'default';
    const permissionMode = pickNonDefaultMode(
        existingSession?.permissionMode,
        savedPermissionMode,
        session.permissionMode,
    ) ?? defaultPermissionMode;

    const modelMode = pickNonDefaultMode(
        existingSession?.modelMode,
        savedModelMode,
        session.modelMode,
    );

    const effortLevel = pickDefinedValue(
        existingSession?.effortLevel,
        savedEffortLevel,
        session.effortLevel,
    );

    return {
        draft: existingSession?.draft || savedDraft || session.draft || null,
        permissionMode,
        ...(modelMode ? { modelMode } : {}),
        ...(effortLevel ? { effortLevel } : {}),
    };
}

export function collectSessionValueMap(
    sessions: Record<string, Pick<Session, 'permissionMode' | 'modelMode' | 'effortLevel'>>,
    field: 'permissionMode' | 'modelMode' | 'effortLevel',
): Record<string, string> {
    const values: Record<string, string> = {};

    for (const [id, session] of Object.entries(sessions)) {
        const value = session[field];
        if (!value) {
            continue;
        }
        if ((field === 'permissionMode' || field === 'modelMode') && value === 'default') {
            continue;
        }
        values[id] = value;
    }

    return values;
}
