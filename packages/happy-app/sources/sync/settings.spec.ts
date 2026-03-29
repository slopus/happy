import { describe, it, expect } from 'vitest';
import { settingsParse, applySettings, settingsDefaults, type Settings } from './settings';

describe('settings', () => {
    describe('settingsParse', () => {
        it('should return defaults when given invalid input', () => {
            expect(settingsParse(null)).toEqual(settingsDefaults);
            expect(settingsParse(undefined)).toEqual(settingsDefaults);
            expect(settingsParse('invalid')).toEqual(settingsDefaults);
            expect(settingsParse(123)).toEqual(settingsDefaults);
            expect(settingsParse([])).toEqual(settingsDefaults);
        });

        it('should return defaults when given empty object', () => {
            expect(settingsParse({})).toEqual(settingsDefaults);
        });

        it('should parse valid settings object', () => {
            const validSettings = {
                viewInline: true
            };
            expect(settingsParse(validSettings)).toEqual({
                ...settingsDefaults,
                viewInline: true
            });
        });

        it('should ignore invalid field types and use defaults', () => {
            const invalidSettings = {
                viewInline: 'not a boolean'
            };
            expect(settingsParse(invalidSettings)).toEqual(settingsDefaults);
        });

        it('should preserve unknown fields (loose schema)', () => {
            const settingsWithExtra = {
                viewInline: true,
                unknownField: 'some value',
                anotherField: 123
            };
            const result = settingsParse(settingsWithExtra);
            expect(result).toEqual({
                ...settingsDefaults,
                viewInline: true,
                unknownField: 'some value',
                anotherField: 123
            });
        });

        it('should handle partial settings and merge with defaults', () => {
            const partialSettings = {
                viewInline: true
            };
            expect(settingsParse(partialSettings)).toEqual({
                ...settingsDefaults,
                viewInline: true
            });
        });

        it('should handle settings with null/undefined values', () => {
            const settingsWithNull = {
                viewInline: null,
                someOtherField: undefined
            };
            expect(settingsParse(settingsWithNull)).toEqual({
                ...settingsDefaults,
                someOtherField: undefined
            });
        });

        it('should handle nested objects as extra fields', () => {
            const settingsWithNested = {
                viewInline: false,
                image: {
                    url: 'http://example.com',
                    width: 100,
                    height: 200
                }
            };
            const result = settingsParse(settingsWithNested);
            expect(result).toEqual({
                ...settingsDefaults,
                viewInline: false,
                image: {
                    url: 'http://example.com',
                    width: 100,
                    height: 200
                }
            });
        });
    });

    describe('applySettings', () => {
        const makeSettings = (overrides: Partial<Settings> = {}): Settings => ({
            ...settingsDefaults,
            ...overrides,
        });

        it('should apply delta to existing settings', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient' });
            const delta: Partial<Settings> = { viewInline: true };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                viewInline: true,
            });
        });

        it('should merge with defaults', () => {
            const currentSettings = makeSettings({ schemaVersion: 1, avatarStyle: 'gradient' });
            const delta: Partial<Settings> = {};
            expect(applySettings(currentSettings, delta)).toEqual(currentSettings);
        });

        it('should override existing values with delta', () => {
            const currentSettings = makeSettings({ viewInline: true, avatarStyle: 'gradient' });
            const delta: Partial<Settings> = { viewInline: false };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                viewInline: false
            });
        });

        it('should handle empty delta', () => {
            const currentSettings = makeSettings({ viewInline: true, avatarStyle: 'gradient' });
            expect(applySettings(currentSettings, {})).toEqual(currentSettings);
        });

        it('should handle extra fields in current settings', () => {
            const currentSettings: any = {
                viewInline: true,
                extraField: 'value'
            };
            const delta: Partial<Settings> = {
                viewInline: false
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...settingsDefaults,
                viewInline: false,
                extraField: 'value'
            });
        });

        it('should handle extra fields in delta', () => {
            const currentSettings = makeSettings({ viewInline: true, avatarStyle: 'gradient' });
            const delta: any = {
                viewInline: false,
                newField: 'new value'
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                viewInline: false,
                newField: 'new value'
            });
        });

        it('should preserve unknown fields from both current and delta', () => {
            const currentSettings: any = {
                viewInline: true,
                existingExtra: 'keep me'
            };
            const delta: any = {
                viewInline: false,
                newExtra: 'add me'
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...settingsDefaults,
                viewInline: false,
                existingExtra: 'keep me',
                newExtra: 'add me'
            });
        });
    });

    describe('settingsDefaults', () => {
        it('should have correct default values', () => {
            expect(settingsDefaults).toEqual({
                schemaVersion: 2,
                viewInline: false,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                alwaysShowContextSize: false,
                avatarStyle: 'brutalist',
                showFlavorIcons: false,
                compactSessionView: false,
                agentInputEnterToSend: true,
                hideInactiveSessions: false,
                expResumeSession: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            });
        });

        it('should be a valid Settings object', () => {
            const parsed = settingsParse(settingsDefaults);
            expect(parsed).toEqual(settingsDefaults);
        });
    });

    describe('forward/backward compatibility', () => {
        it('should handle settings from older version (missing new fields)', () => {
            const oldVersionSettings = {};
            const parsed = settingsParse(oldVersionSettings);
            expect(parsed).toEqual(settingsDefaults);
        });

        it('should handle settings from newer version (extra fields)', () => {
            const newVersionSettings = {
                viewInline: true,
                futureFeature: 'some value',
                anotherNewField: { complex: 'object' }
            };
            const parsed = settingsParse(newVersionSettings);
            expect(parsed.viewInline).toBe(true);
            expect((parsed as any).futureFeature).toBe('some value');
            expect((parsed as any).anotherNewField).toEqual({ complex: 'object' });
        });

        it('should preserve unknown fields when applying changes', () => {
            const settingsWithFutureFields: any = {
                viewInline: false,
                futureField1: 'value1',
                futureField2: 42
            };
            const delta: Partial<Settings> = {
                viewInline: true
            };
            const result = applySettings(settingsWithFutureFields, delta);
            expect(result).toEqual({
                ...settingsDefaults,
                viewInline: true,
                futureField1: 'value1',
                futureField2: 42
            });
        });
    });

    describe('edge cases', () => {
        it('should handle circular references gracefully', () => {
            const circular: any = { viewInline: true };
            circular.self = circular;

            // Should not throw and should return defaults due to parse error
            expect(() => settingsParse(circular)).not.toThrow();
        });

        it('should handle very large objects', () => {
            const largeSettings: any = { viewInline: true };
            for (let i = 0; i < 1000; i++) {
                largeSettings[`field${i}`] = `value${i}`;
            }
            const parsed = settingsParse(largeSettings);
            expect(parsed.viewInline).toBe(true);
            expect(Object.keys(parsed).length).toBeGreaterThan(1000);
        });

        it('should handle settings with prototype pollution attempts', () => {
            const maliciousSettings = {
                viewInline: true,
                '__proto__': { evil: true },
                'constructor': { prototype: { evil: true } }
            };
            const parsed = settingsParse(maliciousSettings);
            expect(parsed.viewInline).toBe(true);
            // Zod's loose() mode doesn't preserve __proto__ as a regular property
            // which is actually good for security
            expect((parsed as any).__proto__).not.toEqual({ evil: true });
            // Constructor property is preserved as a regular property
            expect((parsed as any).constructor).toEqual({ prototype: { evil: true } });
            // Verify no prototype pollution occurred
            expect(({} as any).evil).toBeUndefined();
        });
    });

    describe('version-mismatch scenario', () => {
        it('should preserve pending changes when merging server settings', () => {
            const serverSettings: Partial<Settings> = {
                viewInline: true,
            };

            const pendingChanges: Partial<Settings> = {
                experiments: true,
            };

            const parsedServerSettings = settingsParse(serverSettings);
            expect(parsedServerSettings.experiments).toBe(false);

            const mergedSettings = applySettings(parsedServerSettings, pendingChanges);
            expect(mergedSettings.experiments).toBe(true);
            expect(mergedSettings.viewInline).toBe(true);
        });

        it('should handle multiple pending changes during version-mismatch', () => {
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false
            });

            const pendingChanges: Partial<Settings> = {
                experiments: true,
                analyticsOptOut: true,
            };

            const merged = applySettings(serverSettings, pendingChanges);

            expect(merged.experiments).toBe(true);
            expect(merged.analyticsOptOut).toBe(true);
            expect(merged.viewInline).toBe(false);
        });

        it('should handle empty server settings (server reset scenario)', () => {
            const serverSettings = settingsParse({});

            const pendingChanges: Partial<Settings> = {
                experiments: true
            };

            const merged = applySettings(serverSettings, pendingChanges);
            expect(merged.experiments).toBe(true);
            expect(merged.viewInline).toBe(false);
        });

        it('should preserve user flag when server lacks field', () => {
            const serverSettings = settingsParse({
                schemaVersion: 1,
                viewInline: false,
            });

            const pendingChanges: Partial<Settings> = {
                experiments: true
            };

            const merged = applySettings(serverSettings, pendingChanges);
            expect(merged.experiments).toBe(true);
        });

        it('should handle server settings with extra fields + pending changes', () => {
            const serverSettings = settingsParse({
                viewInline: true,
                futureFeature: 'some value',
                anotherNewField: 123
            });

            const pendingChanges: Partial<Settings> = {
                experiments: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            expect(merged.experiments).toBe(true);
            expect(merged.viewInline).toBe(true);
            expect((merged as any).futureFeature).toBe('some value');
            expect((merged as any).anotherNewField).toBe(123);
        });

        it('should handle empty pending (no local changes)', () => {
            const serverSettings = settingsParse({
                experiments: true,
                viewInline: true
            });

            const pendingChanges: Partial<Settings> = {};

            const merged = applySettings(serverSettings, pendingChanges);
            expect(merged).toEqual(serverSettings);
        });

        it('should handle delta overriding multiple server fields', () => {
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false,
                analyticsOptOut: false
            });

            const pendingChanges: Partial<Settings> = {
                viewInline: true,
                analyticsOptOut: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            expect(merged.viewInline).toBe(true);
            expect(merged.analyticsOptOut).toBe(true);
            expect(merged.experiments).toBe(false);
        });

        it('should preserve complex nested structures during merge', () => {
            const serverSettings = settingsParse({
                dismissedCLIWarnings: {
                    perMachine: { 'machine-1': { claude: true } },
                    global: { codex: true }
                }
            });

            const pendingChanges: Partial<Settings> = {
                experiments: true,
                dismissedCLIWarnings: {
                    perMachine: { 'machine-2': { claude: true } },
                    global: {}
                }
            };

            const merged = applySettings(serverSettings, pendingChanges);

            expect(merged.experiments).toBe(true);
            expect(merged.dismissedCLIWarnings).toEqual(pendingChanges.dismissedCLIWarnings);
        });
    });
});
