import { describe, expect, it } from 'vitest';
import { mergeMobileProjectLocation, replaceMobileProjectLocation, canPopMobileProjectLocation, mobileProjectParent, findProjectForLocation } from './mobileProjectNavigation';

const task = { machine: 'm', project: 'p', feature: 'f', task: 't', conversation: 'recent', view: 'chat' };
describe('mobile Task route ownership', () => {
    it('returns cold Task links to their directory instead of the synthetic home anchor', () => {
        expect(canPopMobileProjectLocation(task, 'index')).toBe(false);
        expect(canPopMobileProjectLocation(task, undefined)).toBe(false);
        expect(canPopMobileProjectLocation(task, 'projects')).toBe(true);
        expect(canPopMobileProjectLocation({}, 'index')).toBe(true);
        const project = { projectPath: 'p', features: [{ featurePath: 'f', title: 'F' }] };
        expect(mobileProjectParent({ feature: 'f', task: 't' }, project)).toMatchObject({ project: 'p', feature: 'f', task: undefined });
        expect(mobileProjectParent({ feature: 'f' }, project)).toMatchObject({ project: 'p', feature: undefined });
        expect(mobileProjectParent({ machine: 'm', project: 'p', feature: 'p' }, { projectPath: 'p', features: [] })).toEqual({ machine: 'm' });
        expect(mobileProjectParent({ author: 'a' })).toMatchObject({ author: undefined });
    });
    it('keeps the all-projects catalog unselected and resolves an explicit feature deep link', () => {
        const projects = [{ projectPath: 'p', title: 'P', features: [{ featurePath: 'f', title: 'F' }] }];
        expect(findProjectForLocation(projects, {})).toBeUndefined();
        expect(findProjectForLocation(projects, { feature: 'f' })).toBe(projects[0]);
        expect(findProjectForLocation(projects, { project: 'missing', feature: 'f' })).toBeUndefined();
    });
    it('replaces views and exact history sessions inside one Task', () => {
        let current = task;
        for (const view of ['details', 'files', 'chat', 'details', 'chat']) {
            const next = mergeMobileProjectLocation(current, { view });
            expect(replaceMobileProjectLocation(current, next)).toBe(true);
            expect(next.conversation).toBe('recent');
            current = next as typeof task;
        }
        expect(replaceMobileProjectLocation(current, { ...current, conversation: 'older' })).toBe(true);
    });
    it('pushes only directory/Task entry and reader entry', () => {
        expect(replaceMobileProjectLocation({ machine: 'm', project: 'p', feature: 'f' }, task)).toBe(false);
        expect(replaceMobileProjectLocation(task, { ...task, view: 'reader', file: '/task/file.md' })).toBe(false);
        expect(replaceMobileProjectLocation(task, { ...task, task: 'other' })).toBe(false);
        expect(replaceMobileProjectLocation(task, { ...task, machine: 'other' })).toBe(false);
    });
    it('clears conversation and reader state on a different Task and handles deep links', () => {
        const next = mergeMobileProjectLocation(task, { task: 'other', conversation: undefined, view: undefined, file: undefined });
        expect(next.conversation).toBeUndefined();
        expect(mobileProjectParent({ ...task, view: 'reader', file: '/task/file.md' })).toEqual({ ...task, view: 'files', file: undefined });
        expect(mobileProjectParent(task)).toMatchObject({ task: undefined, conversation: undefined, feature: 'f', view: undefined });
    });
});
