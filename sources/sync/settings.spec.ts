import { describe, it, expect } from 'vitest';
import { settingsParse, applySettings, settingsDefaults, type Settings, AIBackendProfileSchema } from './settings';
import { getBuiltInProfile } from './profileUtils';

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
                schemaVersion: 1,
                viewInline: false,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                useEnhancedSessionWizard: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'gradient',
                showFlavorIcons: false,
                compactSessionView: false,
                hideInactiveSessions: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: [],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            };
            const delta: Partial<Settings> = {
                viewInline: true
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                schemaVersion: 1, // Preserved from currentSettings
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                useEnhancedSessionWizard: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'gradient', // This should be preserved from currentSettings
                showFlavorIcons: false,
                compactSessionView: false,
                hideInactiveSessions: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: [],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            });
        });

        it('should merge with defaults', () => {
            const currentSettings: Settings = {
                schemaVersion: 1,
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                useEnhancedSessionWizard: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'gradient',
                showFlavorIcons: false,
                compactSessionView: false,
                hideInactiveSessions: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: [],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            };
            const delta: Partial<Settings> = {};
            expect(applySettings(currentSettings, delta)).toEqual(currentSettings);
        });

        it('should override existing values with delta', () => {
            const currentSettings: Settings = {
                schemaVersion: 1,
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                useEnhancedSessionWizard: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'gradient',
                showFlavorIcons: false,
                compactSessionView: false,
                hideInactiveSessions: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: [],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            };
            const delta: Partial<Settings> = {
                viewInline: false
            };
            expect(applySettings(currentSettings, delta)).toEqual({
                ...currentSettings,
                viewInline: false
            });
        });

        it('should handle empty delta', () => {
            const currentSettings: Settings = {
                schemaVersion: 1,
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                useEnhancedSessionWizard: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'gradient',
                showFlavorIcons: false,
                compactSessionView: false,
                hideInactiveSessions: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: [],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            };
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
            const currentSettings: Settings = {
                schemaVersion: 1,
                viewInline: true,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: false,
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                useEnhancedSessionWizard: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'gradient',
                showFlavorIcons: false,
                compactSessionView: false,
                hideInactiveSessions: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: [],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
            };
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
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                preferredLanguage: null,
                recentMachinePaths: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                profiles: [],
                lastUsedProfile: null,
                favoriteDirectories: ['~/src', '~/Desktop', '~/Documents'],
                favoriteMachines: [],
                dismissedCLIWarnings: { perMachine: {}, global: {} },
                useEnhancedSessionWizard: false,
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

    describe('AIBackendProfile validation', () => {
        it('validates built-in Anthropic profile', () => {
            const profile = getBuiltInProfile('anthropic');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in DeepSeek profile', () => {
            const profile = getBuiltInProfile('deepseek');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Z.AI profile', () => {
            const profile = getBuiltInProfile('zai');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in OpenAI profile', () => {
            const profile = getBuiltInProfile('openai');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('validates built-in Azure OpenAI profile', () => {
            const profile = getBuiltInProfile('azure-openai');
            expect(profile).not.toBeNull();
            expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
        });

        it('accepts all 7 permission modes', () => {
            const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo'];
            modes.forEach(mode => {
                const profile = {
                    id: crypto.randomUUID(),
                    name: 'Test Profile',
                    defaultPermissionMode: mode,
                    compatibility: { claude: true, codex: true },
                };
                expect(() => AIBackendProfileSchema.parse(profile)).not.toThrow();
            });
        });

        it('rejects invalid permission mode', () => {
            const profile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                defaultPermissionMode: 'invalid-mode',
                compatibility: { claude: true, codex: true },
            };
            expect(() => AIBackendProfileSchema.parse(profile)).toThrow();
        });

        it('validates environment variable names', () => {
            const validProfile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                environmentVariables: [
                    { name: 'VALID_VAR_123', value: 'test' },
                    { name: 'API_KEY', value: '${SECRET}' },
                ],
                compatibility: { claude: true, codex: true },
            };
            expect(() => AIBackendProfileSchema.parse(validProfile)).not.toThrow();
        });

        it('rejects invalid environment variable names', () => {
            const invalidProfile = {
                id: crypto.randomUUID(),
                name: 'Test Profile',
                environmentVariables: [
                    { name: 'invalid-name', value: 'test' },
                ],
                compatibility: { claude: true, codex: true },
            };
            expect(() => AIBackendProfileSchema.parse(invalidProfile)).toThrow();
        });
    });
});
