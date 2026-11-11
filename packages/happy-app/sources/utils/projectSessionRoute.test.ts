import { describe, expect, it } from 'vitest';
import { projectSessionRoute } from './projectSessionRoute';

describe('sidebar Task conversation routing', () => {
    it('binds the clicked session to its explicit machine and Task, including older history', () => {
        expect(projectSessionRoute('older', { machineId: 'm', goalBoard: { featurePath: '/f', taskId: 't' } })).toEqual({ pathname: '/projects', params: { machine: 'm', feature: '/f', task: 't', conversation: 'older', view: 'chat' } });
    });
    it('leaves ordinary, authoring and incomplete session headers on their existing route', () => {
        expect(projectSessionRoute('s')).toBeNull();
        expect(projectSessionRoute('s', { machineId: 'm' })).toBeNull();
        expect(projectSessionRoute('s', { machineId: 'm', goalBoard: { featurePath: '/f' } })).toBeNull();
        expect(projectSessionRoute('s', { goalBoard: { featurePath: '/f', taskId: 't' } })).toBeNull();
    });
});
