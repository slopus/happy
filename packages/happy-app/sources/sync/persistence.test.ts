import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
    MMKV: vi.fn().mockImplementation(() => ({
        getString: (key: string) => mockStorage.get(key) ?? undefined,
        set: (key: string, value: string) => mockStorage.set(key, value),
        delete: (key: string) => mockStorage.delete(key),
        clearAll: () => mockStorage.clear(),
    }))
}));

import { loadSessionCustomNames, saveSessionCustomNames } from './persistence';

describe('session custom names persistence', () => {
    beforeEach(() => {
        mockStorage.clear();
    });

    describe('loadSessionCustomNames', () => {
        describe('empty state', () => {
            it('should return empty object when no data is stored', () => {
                expect(loadSessionCustomNames()).toEqual({});
            });

            it('should return empty object when key does not exist in storage', () => {
                mockStorage.set('some-other-key', 'value');
                expect(loadSessionCustomNames()).toEqual({});
            });
        });

        describe('valid data', () => {
            it('should return parsed object when valid JSON is stored', () => {
                const names = { 'session-1': 'My Session', 'session-2': 'Another Session' };
                mockStorage.set('session-custom-names', JSON.stringify(names));
                expect(loadSessionCustomNames()).toEqual(names);
            });

            it('should handle a single session name', () => {
                const names = { 'abc-123': 'Frontend' };
                mockStorage.set('session-custom-names', JSON.stringify(names));
                expect(loadSessionCustomNames()).toEqual(names);
            });

            it('should handle many session names', () => {
                const names: Record<string, string> = {};
                for (let i = 0; i < 50; i++) {
                    names[`session-${i}`] = `Name ${i}`;
                }
                mockStorage.set('session-custom-names', JSON.stringify(names));
                expect(loadSessionCustomNames()).toEqual(names);
            });

            it('should handle session names with special characters', () => {
                const names = {
                    'session-1': 'My "Quoted" Name',
                    'session-2': 'Name with émojis 🚀',
                    'session-3': 'Name/with/slashes'
                };
                mockStorage.set('session-custom-names', JSON.stringify(names));
                expect(loadSessionCustomNames()).toEqual(names);
            });
        });

        describe('error handling', () => {
            it('should return empty object when invalid JSON is stored', () => {
                const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
                mockStorage.set('session-custom-names', 'not valid json{{{');
                expect(loadSessionCustomNames()).toEqual({});
                spy.mockRestore();
            });

            it('should return empty object when stored value is empty string', () => {
                mockStorage.set('session-custom-names', '');
                expect(loadSessionCustomNames()).toEqual({});
            });
        });
    });

    describe('saveSessionCustomNames', () => {
        describe('basic functionality', () => {
            it('should save serialized JSON to MMKV', () => {
                const names = { 'session-1': 'Custom Name' };
                saveSessionCustomNames(names);
                expect(mockStorage.get('session-custom-names')).toBe(JSON.stringify(names));
            });

            it('should save empty object', () => {
                saveSessionCustomNames({});
                expect(mockStorage.get('session-custom-names')).toBe('{}');
            });

            it('should handle names with unicode characters', () => {
                const names = { 'session-1': '日本語セッション' };
                saveSessionCustomNames(names);
                expect(JSON.parse(mockStorage.get('session-custom-names')!)).toEqual(names);
            });
        });

        describe('overwrite behavior', () => {
            it('should overwrite previous data completely', () => {
                saveSessionCustomNames({ 'session-1': 'First' });
                saveSessionCustomNames({ 'session-2': 'Second' });
                expect(JSON.parse(mockStorage.get('session-custom-names')!)).toEqual({
                    'session-2': 'Second'
                });
            });

            it('should not merge with previous data', () => {
                saveSessionCustomNames({ 'session-1': 'Name A', 'session-2': 'Name B' });
                saveSessionCustomNames({ 'session-1': 'Updated A' });
                const result = JSON.parse(mockStorage.get('session-custom-names')!);
                expect(result).toEqual({ 'session-1': 'Updated A' });
                expect(result['session-2']).toBeUndefined();
            });
        });

        describe('round-trip', () => {
            it('should save and load data consistently', () => {
                const names = {
                    'session-abc': 'Frontend Server',
                    'session-def': 'Backend API',
                    'session-ghi': 'Database Migration'
                };
                saveSessionCustomNames(names);
                expect(loadSessionCustomNames()).toEqual(names);
            });

            it('should handle save-load-save cycle', () => {
                saveSessionCustomNames({ 'session-1': 'First' });
                const loaded = loadSessionCustomNames();
                loaded['session-2'] = 'Second';
                saveSessionCustomNames(loaded);
                expect(loadSessionCustomNames()).toEqual({
                    'session-1': 'First',
                    'session-2': 'Second'
                });
            });
        });
    });
});
