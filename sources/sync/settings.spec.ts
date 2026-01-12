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

    describe('version-mismatch scenario (bug fix)', () => {
        it('should preserve pending changes when merging server settings', () => {
            // Simulates the bug scenario:
            // 1. User enables useEnhancedSessionWizard (local change)
            // 2. Version-mismatch occurs (server has newer version from another device)
            // 3. Server settings don't have the flag (it was added by this device)
            // 4. Merge should preserve the pending change

            const serverSettings: Partial<Settings> = {
                // Server settings from another device (version 11)
                // Missing useEnhancedSessionWizard because other device doesn't have it
                viewInline: true,
                profiles: [
                    {
                        id: 'server-profile',
                        name: 'Server Profile',
                        anthropicConfig: {},
                        environmentVariables: [],
                        compatibility: { claude: true, codex: true, gemini: true },
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }
                ]
            };

            const pendingChanges: Partial<Settings> = {
                // User's local changes that haven't synced yet
                useEnhancedSessionWizard: true,
                profiles: [
                    {
                        id: 'local-profile',
                        name: 'Local Profile',
                        anthropicConfig: {},
                        environmentVariables: [],
                        compatibility: { claude: true, codex: true, gemini: true },
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }
                ]
            };

            // Parse server settings (fills in defaults for missing fields)
            const parsedServerSettings = settingsParse(serverSettings);

            // Verify server settings default useEnhancedSessionWizard to false
            expect(parsedServerSettings.useEnhancedSessionWizard).toBe(false);

            // Apply pending changes on top of server settings
            const mergedSettings = applySettings(parsedServerSettings, pendingChanges);

            // CRITICAL: Pending changes should override defaults
            expect(mergedSettings.useEnhancedSessionWizard).toBe(true);
            expect(mergedSettings.profiles).toEqual(pendingChanges.profiles);
            expect(mergedSettings.viewInline).toBe(true); // Preserved from server
        });

        it('should handle multiple pending changes during version-mismatch', () => {
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                experiments: true,
                profiles: []
            };

            const merged = applySettings(serverSettings, pendingChanges);

            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.experiments).toBe(true);
            expect(merged.viewInline).toBe(false); // From server
        });

        it('should handle empty server settings (server reset scenario)', () => {
            const serverSettings = settingsParse({});  // Server has no settings

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // Pending change should override default
            expect(merged.useEnhancedSessionWizard).toBe(true);
            // Other fields use defaults
            expect(merged.viewInline).toBe(false);
        });

        it('should preserve user flag when server lacks field', () => {
            // Exact bug scenario:
            // Server has old settings without useEnhancedSessionWizard
            const serverSettings = settingsParse({
                schemaVersion: 1,
                viewInline: false,
                // useEnhancedSessionWizard: NOT PRESENT
            });

            // User enabled flag locally (in pending)
            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Merge for version-mismatch retry
            const merged = applySettings(serverSettings, pendingChanges);

            // BUG WOULD BE: merged.useEnhancedSessionWizard = false (from defaults)
            // FIX IS: merged.useEnhancedSessionWizard = true (from pending)
            expect(merged.useEnhancedSessionWizard).toBe(true);
        });

        it('should handle accumulating pending changes across syncs', () => {
            // Scenario: User makes multiple changes before sync completes

            // Initial state from server
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false
            });

            // First pending change
            const pending1: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Accumulate second change (simulates line 298: this.pendingSettings = { ...this.pendingSettings, ...delta })
            const pending2: Partial<Settings> = {
                ...pending1,
                profiles: [{
                    id: 'test-profile',
                    name: 'Test',
                    anthropicConfig: {},
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    isBuiltIn: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: '1.0.0',
                }]
            };

            // Merge with server settings
            const merged = applySettings(serverSettings, pending2);

            // Both pending changes preserved
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.profiles).toHaveLength(1);
            expect(merged.profiles[0].id).toBe('test-profile');
            // Server settings preserved
            expect(merged.viewInline).toBe(false);
            expect(merged.experiments).toBe(false);
        });

        it('should handle multi-device conflict: Device A flag + Device B profile', () => {
            // Device A and B both at version 10
            // Device A enables flag, Device B adds profile
            // Both POST to server simultaneously
            // One wins (becomes v11), other gets version-mismatch

            // Server accepted Device B's change first (v11)
            const serverSettingsV11 = settingsParse({
                profiles: [{
                    id: 'device-b-profile',
                    name: 'Device B Profile',
                    anthropicConfig: {},
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true },
                    isBuiltIn: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: '1.0.0',
                }]
            });

            // Device A's pending change
            const deviceAPending: Partial<Settings> = {
                useEnhancedSessionWizard: true
            };

            // Device A merges and retries
            const merged = applySettings(serverSettingsV11, deviceAPending);

            // Device A's flag preserved
            expect(merged.useEnhancedSessionWizard).toBe(true);
            // Device B's profile preserved
            expect(merged.profiles).toHaveLength(1);
            expect(merged.profiles[0].id).toBe('device-b-profile');
        });

        it('should handle Device A and B both changing same field', () => {
            // Device A sets flag to true
            // Device B sets flag to false
            // One POSTs first, other gets version-mismatch

            const serverSettings = settingsParse({
                useEnhancedSessionWizard: false  // Device B won
            });

            const deviceAPending: Partial<Settings> = {
                useEnhancedSessionWizard: true  // Device A's conflicting change
            };

            // Device A merges (its pending overrides server)
            const merged = applySettings(serverSettings, deviceAPending);

            // Device A's value wins (last-write-wins for pending changes)
            expect(merged.useEnhancedSessionWizard).toBe(true);
        });

        it('should handle server settings with extra fields + pending changes', () => {
            // Server has newer schema version with new fields
            const serverSettings = settingsParse({
                viewInline: true,
                futureFeature: 'some value',  // Field this device doesn't know about
                anotherNewField: 123
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                experiments: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // Pending changes applied
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.experiments).toBe(true);
            // Server fields preserved
            expect(merged.viewInline).toBe(true);
            expect((merged as any).futureFeature).toBe('some value');
            expect((merged as any).anotherNewField).toBe(123);
        });

        it('should handle empty pending (no local changes)', () => {
            const serverSettings = settingsParse({
                useEnhancedSessionWizard: true,
                viewInline: true
            });

            const pendingChanges: Partial<Settings> = {};

            const merged = applySettings(serverSettings, pendingChanges);

            // Server settings unchanged
            expect(merged).toEqual(serverSettings);
        });

        it('should handle delta overriding multiple server fields', () => {
            const serverSettings = settingsParse({
                viewInline: false,
                experiments: false,
                useEnhancedSessionWizard: false,
                analyticsOptOut: false
            });

            const pendingChanges: Partial<Settings> = {
                viewInline: true,
                useEnhancedSessionWizard: true,
                analyticsOptOut: true
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // All pending changes applied
            expect(merged.viewInline).toBe(true);
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.analyticsOptOut).toBe(true);
            // Un-changed field from server
            expect(merged.experiments).toBe(false);
        });

        it('should preserve complex nested structures during merge', () => {
            const serverSettings = settingsParse({
                profiles: [{
                    id: 'server-profile-1',
                    name: 'Server Profile',
                    anthropicConfig: {},
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true },
                    isBuiltIn: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                    version: '1.0.0',
                }],
                dismissedCLIWarnings: {
                    perMachine: { 'machine-1': ['warning-1'] },
                    global: ['global-warning']
                }
            });

            const pendingChanges: Partial<Settings> = {
                useEnhancedSessionWizard: true,
                profiles: [{
                    id: 'local-profile-1',
                    name: 'Local Profile',
                    anthropicConfig: {},
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    isBuiltIn: false,
                    createdAt: 2000,
                    updatedAt: 2000,
                    version: '1.0.0',
                }],
                dismissedCLIWarnings: {
                    perMachine: { 'machine-2': { claude: true } },
                    global: {}
                }
            };

            const merged = applySettings(serverSettings, pendingChanges);

            // Pending changes completely override (not deep merge)
            expect(merged.useEnhancedSessionWizard).toBe(true);
            expect(merged.profiles).toEqual(pendingChanges.profiles);
            expect(merged.dismissedCLIWarnings).toEqual(pendingChanges.dismissedCLIWarnings);
        });
    });
});
