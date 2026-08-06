import type { SessionRowData } from '@/sync/storage';

export interface SessionRowPresentationLabels {
    disconnected: string;
    remoteLocation: (machineName: string) => string;
    unknownLocation: string;
    unknownAgent: string;
    status: Record<SessionRowData['state'], string>;
    relativeTime: (timestamp: number) => string;
}

export interface SessionRowPresentation {
    title: string;
    project: string;
    path: string;
    machine: string;
    agent: string;
    relativeTime: string;
    status: string;
    location: {
        icon: 'monitor' | 'map-pin';
        text: string;
        tooltip: string;
        kind: 'remote' | 'unknown';
    };
}

function displayAgentFlavor(flavor: string | null, unknownAgent: string): string {
    if (!flavor) return unknownAgent;
    if (flavor.toLowerCase() === 'codex') return 'Codex';
    if (flavor.toLowerCase() === 'claude') return 'Claude';
    if (flavor.toLowerCase() === 'gemini') return 'Gemini';
    return flavor.charAt(0).toUpperCase() + flavor.slice(1);
}

function formatProjectPath(path: string, homeDir: string | null): string {
    if (!homeDir) return path;
    const normalizedHome = homeDir.replace(/[\\/]+$/, '');
    if (path === normalizedHome) return '~';
    if (path.startsWith(`${normalizedHome}/`) || path.startsWith(`${normalizedHome}\\`)) {
        return `~${path.slice(normalizedHome.length)}`;
    }
    return path;
}

export function buildSessionRowPresentation(
    session: SessionRowData,
    machineName: string | null,
    labels: SessionRowPresentationLabels,
): SessionRowPresentation {
    const hasMachine = Boolean(session.machineId);
    const resolvedMachine = hasMachine
        ? machineName || session.machineId!
        : labels.unknownLocation;
    const path = session.path || session.subtitle;
    const project = session.path
        ? formatProjectPath(session.path, session.homeDir)
        : session.subtitle;
    const timestamp = session.activeAt ?? session.createdAt;
    const locationText = hasMachine
        ? labels.remoteLocation(resolvedMachine)
        : labels.unknownLocation;

    return {
        title: session.name,
        project,
        path,
        machine: resolvedMachine,
        agent: displayAgentFlavor(session.flavor, labels.unknownAgent),
        relativeTime: timestamp ? labels.relativeTime(timestamp) : '',
        status: session.isConnected
            ? labels.status[session.state]
            : `${labels.status[session.state]} · ${labels.disconnected}`,
        location: {
            icon: hasMachine ? 'monitor' : 'map-pin',
            text: locationText,
            tooltip: locationText,
            kind: hasMachine ? 'remote' : 'unknown',
        },
    };
}

export function isSessionTitleOverflowing(metrics: {
    clientWidth: number;
    scrollWidth: number;
} | null | undefined): boolean {
    if (!metrics || metrics.clientWidth <= 0) return false;
    return metrics.scrollWidth > metrics.clientWidth + 1;
}

export interface SessionRowInteractionState {
    focused: boolean;
    hovered: boolean;
}

export type SessionRowInteractionEvent =
    | 'focus'
    | 'blur'
    | 'mouse-enter'
    | 'mouse-leave'
    | 'escape';

export function reduceSessionRowInteraction(
    state: SessionRowInteractionState,
    event: SessionRowInteractionEvent,
): SessionRowInteractionState {
    switch (event) {
        case 'focus': return { ...state, focused: true };
        case 'blur': return { ...state, focused: false };
        case 'mouse-enter': return { ...state, hovered: true };
        case 'mouse-leave': return { ...state, hovered: false };
        case 'escape': return { focused: false, hovered: false };
    }
}

export function isSessionRowDisclosureVisible(state: SessionRowInteractionState): boolean {
    return state.focused || state.hovered;
}

export function shouldShowSessionRowDisclosure(
    platform: string,
    viewportWidth: number,
    state: SessionRowInteractionState,
): boolean {
    return platform === 'web'
        && viewportWidth >= 800
        && isSessionRowDisclosureVisible(state);
}

export function shouldUseSessionRowMoreAction(
    platform: string,
    viewportWidth: number,
    canHover = true,
): boolean {
    return platform !== 'web' || viewportWidth < 800 || !canHover;
}

export function stopSessionRowActionPropagation(event: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
}): void {
    event.preventDefault?.();
    event.stopPropagation?.();
}
