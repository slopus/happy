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
        it('should apply delta to existing settings', () => {
            const currentSettings: Settings = {
                viewInline: false,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false
            };
            const delta: Partial<Settings> = {
                viewInline: true
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false
            });
        });

        it('should merge with defaults', () => {
            const currentSettings: Settings = {
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false
            };
            const delta: Partial<Settings> = {};
            expect(applySettings(currentSettings, delta)).toEqual({
                ...settingsDefaults,
                viewInline: true
            });
        });

        it('should override existing values with delta', () => {
            const currentSettings: Settings = {
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false
            };
            const delta: Partial<Settings> = {
                viewInline: false
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                viewInline: false,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null
            });
        });

        it('should handle empty delta', () => {
            const currentSettings: Settings = {
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false
            };
            expect(applySettings(currentSettings, {})).toEqual({
                ...settingsDefaults,
                viewInline: true
            });
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
            const currentSettings: Settings = {
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false
            };
            const delta: any = {
                viewInline: false,
                newField: 'new value'
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...settingsDefaults,
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
                viewInline: false,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null
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
});