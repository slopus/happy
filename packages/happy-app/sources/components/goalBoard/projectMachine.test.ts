import { describe, expect, it } from 'vitest';
import { selectProjectMachine, projectCatalogState, supportsProjectCanvas } from './projectMachine';

const actual = { id: 'actual', active: true };
const previousPreview = { id: 'old-preview', active: false };
const machines = [previousPreview, actual];

describe('project machine ownership', () => {
    it('keeps the configured real machine after sidebar navigation removes route parameters', () => {
        expect(selectProjectMachine(machines, undefined, previousPreview.id, actual.id)).toBe(actual);
        expect(selectProjectMachine(machines, previousPreview.id, previousPreview.id, actual.id)).toBe(actual);
    });
    it('does not fall back to another machine when the preview owner has not hydrated', () => {
        expect(selectProjectMachine([previousPreview], undefined, previousPreview.id, actual.id)).toBeUndefined();
    });
    it('prefers an online machine over an offline chat draft when opening the normal catalog', () => {
        expect(selectProjectMachine(machines, undefined, previousPreview.id)).toBe(actual);
    });
    it('honors explicit normal machine selection, including offline and unavailable owners', () => {
        expect(selectProjectMachine(machines, previousPreview.id, actual.id)).toBe(previousPreview);
        expect(selectProjectMachine(machines, 'missing', actual.id)).toBeUndefined();
    });
});

describe('project canvas availability', () => {
    const running = { status: 'running', startedAt: 1729 };
    const machine = { active: true, daemonState: running, metadata: { projectCanvas: { version: 1, daemonStartedAt: 1729 } } };

    it('requires a supported capability from the current connection of the active daemon', () => {
        expect(supportsProjectCanvas(machine)).toBe(true);
        expect(supportsProjectCanvas(undefined)).toBe(false);
        expect(supportsProjectCanvas({ ...machine, metadata: {} })).toBe(false);
        expect(supportsProjectCanvas({ ...machine, daemonState: { ...running, startedAt: 1730 } })).toBe(false);
        expect(supportsProjectCanvas({ ...machine, daemonState: null })).toBe(false);
        expect(supportsProjectCanvas({ ...machine, active: false })).toBe(false);
        expect(supportsProjectCanvas({ ...machine, metadata: { projectCanvas: { version: 2, daemonStartedAt: 1729 } } })).toBe(false);
    });
});

describe('catalog availability', () => {
    const connected = { connected: true, online: true, loading: false, loaded: false, error: null };
    it('does not treat an unread, disconnected, offline or failed catalog as a successful empty result', () => {
        expect(projectCatalogState(connected)).toBe('loading');
        expect(projectCatalogState({ ...connected, connected: false })).toBe('connecting');
        expect(projectCatalogState({ ...connected, online: false })).toBe('offline');
        expect(projectCatalogState({ ...connected, error: 'RPC unavailable' })).toBe('error');
        expect(projectCatalogState({ ...connected, loaded: true })).toBe('ready');
    });
    it('shows an outage even when the last successful snapshot was empty', () => {
        expect(projectCatalogState({ ...connected, loaded: true, online: false })).toBe('offline');
        expect(projectCatalogState({ ...connected, loaded: true, loading: true })).toBe('loading');
    });
    it('waits for the first machine list before reporting an unavailable machine as offline', () => {
        expect(projectCatalogState({ ...connected, online: false, machinesStatus: 'loading' })).toBe('connecting');
        expect(projectCatalogState({ ...connected, online: false, machinesStatus: 'error' })).toBe('error');
        expect(projectCatalogState({ ...connected, online: false, machinesStatus: 'ready' })).toBe('offline');
    });
});
