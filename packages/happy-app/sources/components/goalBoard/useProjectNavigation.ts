import * as React from 'react';
import { canRouteBack, canRouteForward } from '@/navigation/browserNavigation';
import { createProjectHistory, moveProjectHistory, projectHistoryLocation, projectLocationKey, pushProjectLocation, type ProjectLocation } from './projectNavigation';

/** Query navigation stays on the same route so live file previews keep their owner. */
export function useProjectNavigation(location: ProjectLocation, setParams: (location: ProjectLocation) => void) {
    const [history, setHistory] = React.useState(() => createProjectHistory(location));
    const current = React.useRef(history);
    const setter = React.useRef(setParams); setter.current = setParams;
    const key = projectLocationKey(location);
    React.useEffect(() => {
        if (current.current.stack[current.current.cursor] === key) return;
        const next = pushProjectLocation(current.current, projectHistoryLocation(createProjectHistory(JSON.parse(key))));
        current.current = next; setHistory(next);
    }, [key]);
    const navigate = React.useCallback((patch: ProjectLocation) => {
        const next = pushProjectLocation(current.current, patch);
        if (next === current.current) return;
        current.current = next; setHistory(next); setter.current(projectHistoryLocation(next));
    }, []);
    const move = React.useCallback((direction: -1 | 1) => {
        const next = moveProjectHistory(current.current, direction);
        if (next === current.current) return;
        current.current = next; setHistory(next); setter.current(projectHistoryLocation(next));
    }, []);
    return { navigate, back: () => move(-1), forward: () => move(1), canBack: canRouteBack(history), canForward: canRouteForward(history) };
}
