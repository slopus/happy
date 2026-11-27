import type { GoalProjectCanvasChangeNotice } from '@slopus/happy-wire';
import type { DaemonState } from './types';

/** Derived previews notify canvas consumers without invalidating the project catalog. */
export function projectGoalChangeState(state: DaemonState | null, change?: GoalProjectCanvasChangeNotice,
    token = `${Date.now()}:${Math.random()}`): DaemonState {
    const next = { ...state, status: state?.status ?? 'running' };
    if (!change) return { ...next, goalProjectRevision: token, goalProjectCanvasChange: undefined };
    return { ...next,
        ...(change.kind === 'preview' ? {} : { goalProjectRevision: token }),
        goalProjectCanvasChange: { token, change },
    };
}
