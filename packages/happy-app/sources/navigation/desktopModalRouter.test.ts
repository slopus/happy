import { describe, expect, it, vi } from 'vitest';
import { StackActions, StackRouter } from '@react-navigation/routers';
import { getActionFromState, getStateFromPath } from '@react-navigation/core';
import { existsSync } from 'node:fs';
vi.mock('@react-navigation/native', () => ({ StackRouter }));
import { projectLocationHref, restoreProjectLocation } from '@/utils/projectReturnLocation';
import { sessionWorkspaceRoute } from '@/utils/sessionWorkspaceRoute';
import { createDesktopModalRouter, getDesktopModalStart, getDesktopModalBackgroundPath } from './desktopModalRouter';

const options = { routeNames: ['index', 'projects', 'settings/index', 'settings/delegation-roles', 'new/index', 'settings/appearance', 'settings/device-environment', 'settings/profile', 'session/[id]', 'session/[id]/message/[messageId]', 'session/[id]/file', 'session/[id]/files', 'machine/[id]', 'dev/index', 'dev/logs', 'relationship-advisor'], routeParamList: {}, routeGetIdList: {} };
function setup(shouldPresentToolDetails = () => false) {
    const original = StackRouter({ initialRouteName: 'index' });
    const router = createDesktopModalRouter({ initialRouteName: 'index' }, shouldPresentToolDetails);
    let state = original.getInitialState(options);
    const send = (action: any) => state = router.getStateForAction(state, action, options) ?? state;
    return { send, get state() { return state; } };
}

describe('tool detail presentation', () => {
    it.each(['PUSH', 'NAVIGATE'])('opens existing %s entry points over the exact conversation and closes without replacing it', type => {
        const app = setup(() => true);
        app.send(StackActions.push('session/[id]', { id: 'original' }));
        const background = app.state.routes;
        app.send({ type, payload: { name: 'session/[id]/message/[messageId]', params: { id: 'original', messageId: 'tool-1' } } });
        expect(getDesktopModalStart(app.state)).toBe(2);
        expect(getDesktopModalBackgroundPath(app.state)).toBe('/session/original');
        app.send({ type: 'CLOSE_DESKTOP_MODAL' });
        expect(app.state.routes).toEqual(background);
    });

    it('reads the current breakpoint on each open, preserving narrow-screen page navigation', () => {
        let desktop = false;
        const app = setup(() => desktop);
        app.send(StackActions.push('session/[id]', { id: 'original' }));
        app.send(StackActions.push('session/[id]/message/[messageId]', { id: 'original', messageId: 'tool-1' }));
        expect(getDesktopModalStart(app.state)).toBe(-1);
        app.send({ type: 'GO_BACK' });
        desktop = true;
        app.send(StackActions.push('session/[id]/message/[messageId]', { id: 'original', messageId: 'tool-1' }));
        expect(getDesktopModalStart(app.state)).toBe(2);
    });

    it.each([{ initialRoutes: [] }, { initialRoutes: [{ name: 'index' }] }])('restores a direct detail URL with its own conversation as the close destination ($initialRoutes)', ({ initialRoutes }) => {
        const router = createDesktopModalRouter({ initialRouteName: 'index' }, () => true);
        const restored = router.getRehydratedState({ stale: true, routes: [...initialRoutes,
            { name: 'session/[id]/message/[messageId]', params: { id: 'original', messageId: 'tool-1' } },
        ] }, options);
        expect(getDesktopModalStart(restored)).toBe(restored.index);
        expect(getDesktopModalBackgroundPath(restored)).toBe('/session/original');
        const closed = router.getStateForAction(restored, { type: 'CLOSE_DESKTOP_MODAL' } as any, options)!;
        expect(closed.routes[closed.index]).toMatchObject({ name: 'session/[id]', params: { id: 'original' } });
    });

    it('retains an existing project workspace underneath a restored tool detail', () => {
        const router = createDesktopModalRouter({ initialRouteName: 'index' }, () => true);
        const project = { key: 'project', name: 'projects', params: { project: '/example', conversation: 'original' } };
        const restored = router.getRehydratedState({ stale: true, routes: [project,
            { name: 'session/[id]/message/[messageId]', params: { id: 'original', messageId: 'tool-1' } },
        ] }, options);
        const closed = router.getStateForAction(restored, { type: 'CLOSE_DESKTOP_MODAL' } as any, options)!;
        expect(closed.routes).toEqual([project]);
    });
});

describe('desktop modal navigation boundary', () => {
    it.each([true, false])('round-trips the exact same task/global conversation after stack compaction (task=%s)', async task => {
        const app = setup();
        const projects = [{ projectPath: '/p', title: 'Project', features: [{ featurePath: '/p/f', title: 'Goal' }] }];
        const metadata = { machineId: 'm', path: task ? '/p/f/tasks/t' : '/p/f',
            ...(task ? { goalBoard: { featurePath: '/p/f', taskId: 't' } } : {}) };
        const readBoard = vi.fn().mockResolvedValue({ snapshot: { featurePath: '/p/f', tasks: [{ id: 't', indexPath: '/p/f/tasks/t/index.md' }] } });
        const target = await sessionWorkspaceRoute('selected-old', metadata, projects, readBoard);
        app.send(StackActions.push('projects', { machine: 'other', project: '/other', task: 'different', conversation: 'newest' }));
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 'selected-old' } } });
        expect(app.state.routes.map(route => route.name)).toEqual(['index', 'session/[id]']);
        app.send({ type: 'NAVIGATE', payload: { name: 'projects', params: target!.params } });
        const current = app.state.routes[app.state.index];
        expect(current.name).toBe('projects');
        expect(current.params).toEqual(target!.params);
        expect(current.params).toMatchObject(task ? { task: 't', conversation: 'selected-old', author: undefined }
            : { task: undefined, conversation: undefined, author: 'selected-old' });
    });

    it('restores the project route after conversation navigation removes it from the stack', () => {
        const app = setup();
        const location = { machine: 'mac', project: '/goals/creative-web', feature: '/goals/creative-web/features/design-ops', task: 'four', conversation: 'task-chat' };
        app.send(StackActions.push('projects', location));
        const saved = projectLocationHref(app.state.routes[app.state.index].params as Record<string, unknown>);
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 'another' } } });
        expect(app.state.routes.map(route => route.name)).toEqual(['index', 'session/[id]']);
        const destination = new URL(restoreProjectLocation(saved), 'https://paws.invalid');
        app.send({ type: 'NAVIGATE', payload: { name: 'projects', params: Object.fromEntries(destination.searchParams) } });
        expect(app.state.routes[app.state.index].name).toBe('projects');
        expect(app.state.routes[app.state.index].params).toEqual(location);
    });

    it('switches conversations in one action while keeping only the original home anchor', () => {
        const app = setup();
        const home = app.state.routes[0];
        app.send(StackActions.push('session/[id]', { id: 'first' }));
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 'second' } } });
        expect(app.state.routes.map(route => route.name)).toEqual(['index', 'session/[id]']);
        expect(app.state.routes[0]).toBe(home);
        expect(app.state.routes[app.state.index].params).toEqual({ id: 'second' });
        const selected = app.state;
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 'second' } } });
        expect(app.state).toBe(selected);
        app.send({ type: 'GO_BACK' });
        expect(app.state.routes).toEqual([home]);
    });

    it('retains the exact background and keeps nested destinations inside until close', () => {
        const app = setup();
        app.send(StackActions.push('session/[id]', { id: 'background' }));
        const background = app.state.routes;
        app.send(StackActions.push('settings/appearance', { desktopModal: '1' }));
        expect(getDesktopModalStart(app.state)).toBe(2);
        expect(app.state.routes.at(-1)?.params).not.toHaveProperty('desktopModal');
        app.send(StackActions.push('session/[id]', { id: 'attached' }));
        app.send(StackActions.push('machine/[id]', { id: 'computer' }));
        expect(getDesktopModalStart(app.state)).toBe(2);
        app.send({ type: 'CLOSE_DESKTOP_MODAL' });
        expect(app.state.routes).toEqual(background);
        expect(getDesktopModalStart(app.state)).toBe(-1);
    });

    it('keeps replace at the modal root in the modal', () => {
        const app = setup();
        app.send(StackActions.push('settings/index', { desktopModal: '1' }));
        app.send(StackActions.replace('relationship-advisor'));
        expect(getDesktopModalStart(app.state)).toBe(1);
        app.send({ type: 'GO_BACK' });
        expect(app.state.routes.map(r => r.name)).toEqual(['index']);
        expect(getDesktopModalStart(app.state)).toBe(-1);
    });

    it('does not let navigate or dismissTo a background destination escape', () => {
        const app = setup();
        app.send(StackActions.push('settings/index', { desktopModal: '1' }));
        const base = app.state.routes[0];
        app.send({ type: 'NAVIGATE', payload: { name: 'index' } });
        expect(app.state.routes[0]).toBe(base);
        expect(app.state.routes.filter(r => r.name === 'index')).toHaveLength(2);
        expect(getDesktopModalStart(app.state)).toBe(1);
        app.send(StackActions.popToTop());
        app.send(StackActions.popTo('session/[id]', { id: 'new' }));
        expect(getDesktopModalStart(app.state)).toBe(1);
        expect(app.state.routes[0]).toBe(base);
    });

    it('pops nested pages one at a time and preserves mobile/narrow entry behavior', () => {
        const app = setup();
        app.send(StackActions.push('settings/index'));
        expect(getDesktopModalStart(app.state)).toBe(-1);
        app.send({ type: 'GO_BACK' });
        app.send(StackActions.push('settings/index', { desktopModal: '1' }));
        app.send(StackActions.push('dev/index'));
        app.send(StackActions.push('dev/logs'));
        app.send({ type: 'GO_BACK' });
        expect(app.state.routes.at(-1)?.name).toBe('dev/index');
        app.send({ type: 'CLOSE_DESKTOP_MODAL' });
        app.send(StackActions.push('settings/appearance', { desktopModal: '1' }));
        expect(app.state.routes.map(r => r.name)).toEqual(['index', 'settings/appearance']);
    });

    it('keeps Device Environment inside Settings until back and close restore the workspace', () => {
        const app = setup();
        app.send(StackActions.push('session/[id]', { id: 'background' }));
        const background = app.state.routes;
        app.send(StackActions.push('settings/index', { desktopModal: '1' }));
        app.send(StackActions.push('settings/device-environment'));

        expect(app.state.routes.map(route => route.name)).toEqual([
            'index', 'session/[id]', 'settings/index', 'settings/device-environment',
        ]);
        expect(getDesktopModalStart(app.state)).toBe(2);

        app.send({ type: 'GO_BACK' });
        expect(app.state.routes.map(route => route.name)).toEqual(['index', 'session/[id]', 'settings/index']);
        expect(getDesktopModalStart(app.state)).toBe(2);

        app.send({ type: 'CLOSE_DESKTOP_MODAL' });
        expect(app.state.routes).toEqual(background);
        expect(getDesktopModalStart(app.state)).toBe(-1);
    });
});

describe('modal boundary edge actions', () => {
    it('clamps a bulk dismiss to the background and does not mutate input state on no-op', () => {
        const app = setup();
        app.send(StackActions.push('session/[id]', { id: 'background' }));
        const before = app.state;
        app.send(StackActions.push('settings/appearance', { desktopModal: '1' }));
        const active = app.state;
        app.send(StackActions.pop(99));
        expect(app.state.routes).toEqual(before.routes);
        expect(getDesktopModalStart(active)).toBe(2);
    });
});

describe('restored desktop modal state', () => {
    it('keeps the workspace on the background route across modal descendants', () => {
        const app = setup();
        app.send(StackActions.push('session/[id]', { id: 'main-session' }));
        app.send(StackActions.push('settings/index', { desktopModal: '1' }));
        app.send(StackActions.push('settings/appearance'));
        const root = { index: 0, routes: [{ key: 'app', name: '(app)', state: app.state }] };
        expect(getDesktopModalBackgroundPath(root)).toBe('/session/main-session');
        app.send({ type: 'CLOSE_DESKTOP_MODAL' });
        expect(getDesktopModalBackgroundPath(app.state)).toBeNull();
    });
    it('preserves the boundary through stale navigation-state rehydration', () => {
        const app = setup();
        app.send(StackActions.push('settings/index', { desktopModal: '1' }));
        app.send(StackActions.push('settings/appearance'));
        const router = createDesktopModalRouter({ initialRouteName: 'index' });
        const restored = router.getRehydratedState({ ...app.state, stale: true, routes: app.state.routes.map(({ state: nestedState, ...route }) => route) }, options);
        expect(getDesktopModalStart(restored)).toBe(1);
    });
});


describe('desktop file handoff navigation', () => {
    it('updates file requests on the current conversation without replacing its route identity', () => {
        const app = setup(); app.send(StackActions.push('session/[id]', { id: 's' }));
        const key = app.state.routes[1].key;
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 's', openFile: 'ZmlsZQ==', fileOpenRequest: 'first' } } });
        expect(app.state.routes[1]).toMatchObject({ key, params: { openFile: 'ZmlsZQ==', fileOpenRequest: 'first' } });
        expect(app.state.routes).toHaveLength(2);
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 's', openFile: 'ZmlsZQ==', fileOpenRequest: 'second' } } });
        expect(app.state.routes[1].params).toHaveProperty('fileOpenRequest', 'second');
    });
    it.each(['session/[id]/file','session/[id]/files'])('reuses the existing session under %s, removing the legacy page so Back cannot reopen it', name => {
        const app = setup(); app.send(StackActions.push('session/[id]', { id: 's' }));
        const key = app.state.routes[1].key;
        app.send(StackActions.push(name, { id: 's' }));
        app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 's', openFile: 'ZmlsZQ==', fileOpenRequest: 'handoff' } } });
        expect(app.state.routes.map(route=>route.name)).toEqual(['index','session/[id]']);
        expect(app.state.routes[1].key).toBe(key);
        app.send({ type: 'GO_BACK' }); expect(app.state.routes.map(route=>route.name)).toEqual(['index']);
    });
});


it('replaces a direct legacy file URL without leaving a redirect loop on Back', () => {
    const original = StackRouter({ initialRouteName: 'index' });
    const router = createDesktopModalRouter({ initialRouteName: 'index' });
    const state = original.getRehydratedState({ stale: true, index: 0, routes: [{ name: 'session/[id]/file', params: { id: 's' } }] }, options);
    const next = router.getStateForAction(state, { type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 's', openFile: 'ZmlsZQ==', fileOpenRequest: 'direct' } } }, options)!;
    expect(next.routes.map(route=>route.name)).toEqual(['session/[id]']);
    expect(next.routes[0].params).toHaveProperty('fileOpenRequest', 'direct');
});

it('hands a selected file out of a desktop picker to its original conversation', () => {
    const app = setup();
    app.send(StackActions.push('session/[id]', { id: 's' }));
    const conversation = app.state.routes[1];
    app.send(StackActions.push('session/[id]/files', { id: 's', desktopModal: '1' }));
    expect(getDesktopModalStart(app.state)).toBe(2);
    app.send({ type: 'NAVIGATE', payload: { name: 'session/[id]', params: { id: 's', openFile: 'ZmlsZQ==', fileOpenRequest: 'picker' } } });
    expect(getDesktopModalStart(app.state)).toBe(-1);
    expect(app.state.routes).toHaveLength(2);
    expect(app.state.routes[1].key).toBe(conversation.key);
    expect(app.state.routes[1].params).toMatchObject({ openFile: 'ZmlsZQ==' });
});

describe('ordinary role configuration workspace handoff',()=>{
    // Derive route identities from the real Expo source paths, then run actual
    // linking actions. `/new` is registered as `new/index`, not `new`.
    function routeFromSource(source: string) {
        expect(existsSync(new URL(`../app/(app)/${source}`, import.meta.url))).toBe(true);
        return source.replace(/\.tsx$/, '');
    }
    function actionFromHref(href: string) {
        const screens = {
            [routeFromSource('new/index.tsx')]: { path: 'new' },
            [routeFromSource('session/[id].tsx')]: { path: 'session/:id' },
            [routeFromSource('settings/delegation-roles.tsx')]: { path: 'settings/delegation-roles' },
        };
        const state = getStateFromPath(href, { screens });
        expect(state).toBeDefined();
        const action = getActionFromState(state!, { screens });
        expect(action?.type).toBe('NAVIGATE');
        if (action?.type !== 'NAVIGATE') throw new Error('Expected a linked navigation action');
        return action;
    }
    it.each(['/new?roleConfiguration=rc-test','/session/configuration?roleConfiguration=rc-test'])('leaves the settings modal only for a real linked role route (%s)',href=>{
        const app=setup();app.send(StackActions.push('session/[id]',{id:'original'}));
        app.send(StackActions.push('settings/index',{desktopModal:'1'}));app.send(StackActions.push('settings/delegation-roles'));
        expect(getDesktopModalStart(app.state)).toBeGreaterThanOrEqual(0);
        const action=actionFromHref(href);const name=action.payload.name;
        expect(name).toBe(href.startsWith('/new')?'new/index':'session/[id]');
        app.send(action);
        expect(getDesktopModalStart(app.state)).toBe(-1);expect(app.state.routes[app.state.index].name).toBe(name);
        app.send(actionFromHref('/settings/delegation-roles?machineId=m&roleConfigurationReturn=rc-test&desktopModal=1'));
        expect(getDesktopModalStart(app.state)).toBeGreaterThanOrEqual(0);expect(getDesktopModalBackgroundPath(app.state)).toBe(name==='new/index'?'/new':'/session/configuration');
    });
    it('keeps an ordinary /new navigation scoped to its existing modal',()=>{
        const app=setup();app.send(StackActions.push('settings/index',{desktopModal:'1'}));
        app.send(actionFromHref('/new'));expect(getDesktopModalStart(app.state)).toBeGreaterThanOrEqual(0);
    });
});
