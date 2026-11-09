import { StackRouter, type ParamListBase, type StackNavigationState, type StackRouterOptions } from '@react-navigation/native';

type ModalState = StackNavigationState<ParamListBase> & { desktopModalBaseKey?: string };

/** The boundary is a route identity: duplicate paths cannot change the background. */
export function getDesktopModalStart(state: StackNavigationState<ParamListBase>): number {
    const baseKey = (state as ModalState).desktopModalBaseKey;
    const baseIndex = baseKey ? state.routes.findIndex(route => route.key === baseKey) : -1;
    return baseIndex >= 0 && baseIndex < state.index ? baseIndex + 1 : -1;
}

type NestedState = { index?: number; desktopModalBaseKey?: string; routes: readonly { key?: string; name: string; params?: object; state?: NestedState }[] };

/** Read the background route from the same navigation snapshot as usePathname. */
export function getDesktopModalBackgroundPath(state: NestedState | undefined): string | null {
    if (!state) return null;
    const baseIndex = state.desktopModalBaseKey ? state.routes.findIndex(route => route.key === state.desktopModalBaseKey) : -1;
    if (baseIndex >= 0 && baseIndex < (state.index ?? 0)) {
        const route = state.routes[baseIndex];
        const params = (route.params ?? {}) as Record<string, unknown>;
        const name = route.name.replace(/\[([^\]]+)\]/g, (_, key: string) => encodeURIComponent(String(params[key] ?? '')));
        return '/' + name.replace(/(^|\/)index$/, '').replace(/\/$/, '');
    }
    return getDesktopModalBackgroundPath(state.routes[state.index ?? 0]?.state);
}

export function createDesktopModalRouter(options: StackRouterOptions) {
    const original = StackRouter(options);
    return {
        ...original,
        getRehydratedState(partialState: Parameters<typeof original.getRehydratedState>[0], config: Parameters<typeof original.getRehydratedState>[1]): ModalState {
            const restored = { ...original.getRehydratedState(partialState, config), desktopModalBaseKey: (partialState as ModalState).desktopModalBaseKey };
            if (getDesktopModalStart(restored) < 0) restored.desktopModalBaseKey = undefined;
            return restored;
        },
        getStateForAction(state: ModalState, action: Parameters<typeof original.getStateForAction>[1], config: Parameters<typeof original.getStateForAction>[2]): ModalState | null {
            const start = getDesktopModalStart(state);
            if ((action.type as string) === 'CLOSE_DESKTOP_MODAL') {
                if (start < 0) return state;
                return { ...state, routes: state.routes.slice(0, start), index: start - 1, desktopModalBaseKey: undefined };
            }
            const payload = 'payload' in action ? action.payload : undefined;
            const params = payload && 'params' in payload ? payload.params as Record<string, unknown> | undefined : undefined;
            const opensModal = params?.desktopModal === '1';
            let nextAction = action;
            if (start >= 0 && action.type === 'POP') {
                nextAction = { ...action, payload: { ...action.payload, count: Math.min(action.payload.count, state.index - start + 1) } };
            }
            if (opensModal) {
                const { desktopModal: _marker, ...routeParams } = params;
                nextAction = { ...action, payload: { ...payload, params: routeParams } } as typeof action;
            }

            // Run forward/reset navigation on the modal's own slice. Even navigate('/')
            // and the session launcher's dismissTo('/') cannot consume the background.
            const scoped = start >= 0 && !['GO_BACK', 'POP'].includes(action.type);
            let activeState = scoped
                ? { ...state, routes: state.routes.slice(start), index: state.index - start }
                : state;
            // Switch conversations atomically instead of publishing an intermediate
            // home route. Keep the home anchor and at most one conversation; modal
            // descendants continue to use their isolated stack above.
            if (start < 0 && !opensModal && action.type === 'NAVIGATE'
                && action.payload.name === 'session/[id]') {
                if (typeof params?.openFile === 'string' && typeof params?.fileOpenRequest === 'string') {
                    const existingIndex = state.routes.findIndex(route => route.name === 'session/[id]'
                        && (route.params as { id?: unknown } | undefined)?.id === params.id);
                    if (existingIndex >= 0) {
                        const route = state.routes[existingIndex];
                        const sameRequest = (route.params as Record<string, unknown>)?.fileOpenRequest === params.fileOpenRequest;
                        if (existingIndex === state.index && sameRequest) return state;
                        const routes = state.routes.slice(0, existingIndex + 1);
                        routes[existingIndex] = { ...route, params: { ...route.params, ...params } };
                        return { ...state, routes, index: existingIndex };
                    }
                }
                const current = state.routes[state.index];
                if (current.name === 'session/[id]' && current.params
                    && (current.params as { id?: unknown }).id === params?.id) {
                    return state;
                }
                const home = state.routes.find(route => route.name === 'index');
                if (home) activeState = { ...state, routes: [home], index: 0 };
                else if (typeof params?.fileOpenRequest === 'string'
                    && ['session/[id]/file', 'session/[id]/files'].includes(current.name)
                    && (current.params as { id?: unknown } | undefined)?.id === params.id) {
                    // A direct old URL may have no conversation or home underneath it.
                    // Replace it so Back cannot return to a page that redirects again.
                    nextAction = { type: 'REPLACE', payload: { name: 'session/[id]', params } };
                }
            }
            const resolved = original.getStateForAction(activeState, nextAction, config);
            if (!resolved) return null;
            const next = resolved.stale === false ? resolved : original.getRehydratedState(resolved, config);
            const result: ModalState = scoped
                ? { ...next, routes: [...state.routes.slice(0, start), ...next.routes], index: start + next.index }
                : { ...next };
            result.desktopModalBaseKey = start >= 0
                ? state.desktopModalBaseKey
                : opensModal ? state.routes[state.index]?.key : undefined;
            if (getDesktopModalStart(result) < 0) result.desktopModalBaseKey = undefined;
            return result;
        },
    };
}
