import { describe, it, expect } from 'vitest';
import {
    applySettings,
    mergeServerSettings,
    mergeSessionPinnedOrders,
    resolveSessionPinnedOrderMigration,
    resolveSidebarOrganizationMigration,
    settingsDefaults,
    settingsParse,
    settingsToSyncPayload,
    type Settings,
} from './settings';

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

        it('validates sidebar organization as an account-synced database setting', () => {
            const organization = {
                lists: [{
                    id: 'list-1',
                    name: 'Happy',
                    kind: 'workspace' as const,
                    color: 'blue' as const,
                    machineId: 'machine-1',
                    path: '/Users/jacky/jacky-github',
                    defaultAgent: 'codex' as const,
                    createdAt: 1,
                }],
                tags: [{ id: 'tag-1', name: '同步', color: 'green' as const, createdAt: 2 }],
                sessions: {
                    'session-1': { listId: 'list-1', tagIds: ['tag-1'] },
                },
            };

            expect(settingsParse({ sidebarOrganization: organization }).sidebarOrganization).toEqual(organization);
            expect(settingsParse({ sidebarOrganization: 'device-only' }).sidebarOrganization).toEqual({
                lists: [],
                tags: [],
                sessions: {},
            });
            expect(settingsParse({
                sidebarOrganization: {
                    lists: [...organization.lists, { id: 'broken', kind: 'future-kind' }],
                    tags: organization.tags,
                    sessions: organization.sessions,
                },
            }).sidebarOrganization).toEqual(organization);
        });

        it('validates pinned session order as an account-synced database setting', () => {
            expect(settingsParse({ sessionPinnedOrder: ['session-b', 'session-a', 'session-b'] }).sessionPinnedOrder)
                .toEqual(['session-b', 'session-a']);
            expect(settingsParse({ sessionPinnedOrder: ['session-a', 42, ''] }).sessionPinnedOrder)
                .toEqual([]);
        });

        it('preserves an unrecognized pinned-order payload for forward-compatible writes', () => {
            const futurePinnedOrder = { version: 2, ids: ['session-a'] };
            const parsed = settingsParse({
                viewInline: true,
                sessionPinnedOrder: futurePinnedOrder,
            });

            expect(parsed.viewInline).toBe(true);
            expect(parsed.sessionPinnedOrder).toEqual([]);
            expect(parsed.sessionPinnedOrderRaw).toEqual(futurePinnedOrder);
            expect(settingsToSyncPayload(parsed).sessionPinnedOrder).toEqual(futurePinnedOrder);
        });

        describe('agents field', () => {
            it('defaults to empty array', () => {
                expect(settingsParse({}).agents).toEqual([]);
            });
            it('parses a valid agent entry', () => {
                const a = { id: 'x1', name: '工作日程', glyph: '日', color: '#5e5791', machineId: 'm1', path: '~/work', presets: [{ label: '看今天', prompt: '列出今天事项' }] };
                expect(settingsParse({ agents: [a] }).agents).toEqual([{ ...a, kind: 'standard', spaceType: 'default', imageStyleIds: [], imageVariantsPerStyle: 1 }]);
            });
            it('defaults legacy synchronized agents to the default space type', () => {
                const legacy = { id: 'legacy', name: 'Legacy', glyph: 'L', color: '#5e5791', machineId: 'm1', path: '~/健康打卡', presets: [] };

                expect(settingsParse({ agents: [legacy] }).agents[0]?.spaceType).toBe('default');
            });
            it('parses GPT Image 2 style generator agents', () => {
                const a = {
                    id: 'img1',
                    name: 'Tiramisu styles',
                    glyph: 'T',
                    color: '#8B5E3C',
                    machineId: 'm1',
                    path: '~/work',
                    kind: 'image-styles',
                    spaceType: 'default',
                    imageStyleIds: ['premium-studio', 'white-product'],
                    imageVariantsPerStyle: 2,
                    presets: [],
                };

                expect(settingsParse({ agents: [a] }).agents).toEqual([a]);
            });
            it('parses custom GPT Image 2 style assets', () => {
                const customImageStyles = [{
                    id: 'user-reference/u1',
                    title: '山野速写',
                    promptHint: '用户参考照片风格：山野速写。',
                    referenceImages: [{
                        id: 'r1',
                        uri: 'file:///style.jpg',
                        width: 800,
                        height: 1000,
                        mimeType: 'image/jpeg',
                        size: 123,
                        name: 'style.jpg',
                    }],
                    createdAt: 1,
                    updatedAt: 1,
                }];

                expect(settingsParse({ customImageStyles }).customImageStyles).toEqual([{
                    ...customImageStyles[0],
                    tags: [],
                    analysisStatus: 'reference-ready',
                    promptSource: 'reference-image',
                }]);
            });
            it('preserves extracted custom GPT Image 2 style prompt metadata', () => {
                const customImageStyles = [{
                    id: 'user-reference/u2',
                    title: '胶片',
                    promptHint: '低饱和胶片',
                    promptContent: '低饱和暖色胶片、柔和窗光、轻微颗粒。',
                    negativePrompt: '过曝',
                    tags: ['胶片'],
                    analysisStatus: 'prompt-ready',
                    analysisError: undefined,
                    analyzedAt: 2,
                    promptSource: 'extracted-prompt',
                    referenceImages: [],
                    createdAt: 1,
                    updatedAt: 2,
                }];

                expect(settingsParse({ customImageStyles }).customImageStyles).toEqual(customImageStyles);
            });
            it('parses pending GPT Image 2 style reference drafts', () => {
                const pendingCustomImageStyleReferences = [{
                    id: 'draft-r1',
                    uri: 'file:///draft.jpg',
                    width: 800,
                    height: 600,
                    mimeType: 'image/jpeg',
                    size: 321,
                    name: 'draft.jpg',
                }];

                expect(settingsParse({ pendingCustomImageStyleReferences }).pendingCustomImageStyleReferences).toEqual(pendingCustomImageStyleReferences);
            });
            it('drops malformed agents back to default', () => {
                expect(settingsParse({ agents: 'nope' }).agents).toEqual([]);
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
                customInstructions: '',
                viewInline: false,
                expandTodos: true,
                showLineNumbers: true,
                showLineNumbersInToolViews: false,
                wrapLinesInDiffs: true,
                diffStyle: 'unified',
                analyticsOptOut: false,
                inferenceOpenAIKey: null,
                experiments: false,
                alwaysShowContextSize: false,
                agentInputEnterToSend: true,
                avatarStyle: 'brutalist',
                showFlavorIcons: false,
                hideInactiveSessions: true,
                expResumeSession: false,
                fileDiffsSidebar: false,
                groupToolCalls: false,
                expImageUpload: false,
                reviewPromptAnswered: false,
                reviewPromptLikedApp: null,
                voiceAssistantLanguage: null,
                voiceCustomAgentId: null,
                voiceBypassToken: false,
                preferredLanguage: null,
                recentMachinePaths: [],
                quickPrompts: [],
                pendingCustomImageStyleReferences: [],
                customImageStyles: [],
                lastUsedAgent: null,
                lastUsedPermissionMode: null,
                lastUsedModelMode: null,
                agentDefaultOverrides: {},
                sessionPinnedOrder: [],
                sessionPinnedOrderRaw: null,
                sidebarOrganization: { lists: [], tags: [], sessions: {} },
                sidebarOrganizationRaw: null,
                dismissedCLIWarnings: { perMachine: {}, global: {} },
                agents: [],
            });
        });

        it('should be a valid Settings object', () => {
            const parsed = settingsParse(settingsDefaults);
            expect(parsed).toEqual(settingsDefaults);
        });
    });

    describe('settingsToSyncPayload', () => {
        it('omits empty agent default overrides', () => {
            expect(settingsToSyncPayload(settingsDefaults)).not.toHaveProperty('agentDefaultOverrides');
        });

        it('omits empty per-agent override objects', () => {
            expect(settingsToSyncPayload({
                ...settingsDefaults,
                agentDefaultOverrides: {
                    codex: {},
                },
            })).not.toHaveProperty('agentDefaultOverrides');
        });

        it('keeps user-selected agent default overrides', () => {
            const settings = {
                ...settingsDefaults,
                agentDefaultOverrides: {
                    codex: { modelMode: 'gpt-5.4' },
                },
            };

            expect(settingsToSyncPayload(settings)).toMatchObject({
                agentDefaultOverrides: {
                    codex: { modelMode: 'gpt-5.4' },
                },
            });
        });
    });

    describe('mergeServerSettings', () => {
        const agent = {
            id: 'agent-1',
            name: 'Mac mini',
            glyph: 'M',
            color: '#5e5791',
            machineId: 'machine-1',
            path: '~/jacky-github/happy',
            kind: 'standard' as const,
            spaceType: 'default' as const,
            imageStyleIds: [],
            imageVariantsPerStyle: 1,
            presets: [{ label: 'Plan', prompt: 'Make a plan' }],
        };

        it('preserves local agents when a server payload predates the agents field', () => {
            const localSettings = {
                ...settingsDefaults,
                agents: [agent],
            };
            const serverRaw = {
                viewInline: true,
            };

            const merged = mergeServerSettings(
                localSettings,
                settingsParse(serverRaw),
                {},
                serverRaw,
            );

            expect(merged.viewInline).toBe(true);
            expect(merged.agents).toEqual([agent]);
        });

        it('accepts an explicit empty agents list from the server', () => {
            const localSettings = {
                ...settingsDefaults,
                agents: [agent],
            };
            const serverRaw = {
                agents: [],
            };

            const merged = mergeServerSettings(
                localSettings,
                settingsParse(serverRaw),
                {},
                serverRaw,
            );

            expect(merged.agents).toEqual([]);
        });

        const customStyle = {
            id: 'user-reference/u1',
            title: '胶片风',
            promptHint: '用户参考照片风格：胶片风。',
            promptContent: '柔和逆光、巨幅圆形散景、通透胶片色彩。',
            tags: [],
            analysisStatus: 'prompt-ready' as const,
            promptSource: 'extracted-prompt' as const,
            referenceImages: [{
                id: 'r1',
                uri: 'file:///ref.jpg',
                width: 800,
                height: 1000,
                mimeType: 'image/jpeg',
                size: 123,
                name: 'ref.jpg',
            }],
            createdAt: 1,
            updatedAt: 2,
        };

        it('preserves local customImageStyles when a server payload predates the field', () => {
            const localSettings = {
                ...settingsDefaults,
                customImageStyles: [customStyle],
            };
            const serverRaw = {
                viewInline: true,
            };

            const merged = mergeServerSettings(
                localSettings,
                settingsParse(serverRaw),
                {},
                serverRaw,
            );

            expect(merged.viewInline).toBe(true);
            expect(merged.customImageStyles).toEqual([customStyle]);
        });

        it('accepts an explicit empty customImageStyles list from the server', () => {
            const localSettings = {
                ...settingsDefaults,
                customImageStyles: [customStyle],
            };
            const serverRaw = {
                customImageStyles: [],
            };

            const merged = mergeServerSettings(
                localSettings,
                settingsParse(serverRaw),
                {},
                serverRaw,
            );

            expect(merged.customImageStyles).toEqual([]);
        });

        it('preserves sidebar organization when an older server payload omits the field', () => {
            const organization = {
                lists: [],
                tags: [{ id: 'tag-1', name: '同步', color: 'green' as const, createdAt: 1 }],
                sessions: { 'session-1': { listId: null, tagIds: ['tag-1'] } },
            };
            const serverRaw = { viewInline: true };

            const merged = mergeServerSettings(
                { ...settingsDefaults, sidebarOrganization: organization },
                settingsParse(serverRaw),
                {},
                serverRaw,
            );

            expect(merged.sidebarOrganization).toEqual(organization);
        });

        it('preserves pinned sessions when an older server payload omits the field', () => {
            const serverRaw = { viewInline: true };
            const merged = mergeServerSettings(
                { ...settingsDefaults, sessionPinnedOrder: ['session-b', 'session-a'] },
                settingsParse(serverRaw),
                {},
                serverRaw,
            );

            expect(merged.sessionPinnedOrder).toEqual(['session-b', 'session-a']);
        });
    });

    describe('pinned session migration and conflict merge', () => {
        it('uploads legacy device-local pins only when the database field is absent', () => {
            expect(resolveSessionPinnedOrderMigration(
                { viewInline: true },
                [],
                ['session-b', 'session-a'],
            )).toEqual({ pinnedOrder: ['session-b', 'session-a'], shouldUpload: true });
            expect(resolveSessionPinnedOrderMigration(
                { sessionPinnedOrder: [] },
                [],
                ['session-b', 'session-a'],
            )).toEqual({ pinnedOrder: [], shouldUpload: false });
        });

        it('keeps independent concurrent pins while honoring a local unpin', () => {
            expect(mergeSessionPinnedOrders(
                ['existing'],
                ['local-added'],
                ['remote-added', 'existing'],
            )).toEqual(['local-added', 'remote-added']);
        });

        it('preserves an independent remote reorder when local only adds a pin', () => {
            expect(mergeSessionPinnedOrders(
                ['session-a', 'session-b'],
                ['session-c', 'session-a', 'session-b'],
                ['session-b', 'session-a'],
            )).toEqual(['session-c', 'session-b', 'session-a']);
        });

        it('uses the local reorder when both clients reorder the same base pins', () => {
            expect(mergeSessionPinnedOrders(
                ['session-a', 'session-b', 'session-c'],
                ['session-c', 'session-a', 'session-b'],
                ['session-b', 'session-c', 'session-a'],
            )).toEqual(['session-c', 'session-a', 'session-b']);
        });

        it('keeps multiple local additions ordered within the same insertion region', () => {
            expect(mergeSessionPinnedOrders(
                ['session-a'],
                ['session-a', 'local-c', 'local-d'],
                ['remote-b', 'session-a', 'local-c'],
            )).toEqual(['remote-b', 'session-a', 'local-c', 'local-d']);
        });
    });

    describe('sidebar organization migration', () => {
        const legacyOrganization = {
            lists: [],
            tags: [{ id: 'tag-1', name: '本地标签', color: 'blue' as const, createdAt: 1 }],
            sessions: { 'session-1': { listId: null, tagIds: ['tag-1'] } },
        };

        it('uploads legacy device-local data when the database field is absent', () => {
            expect(resolveSidebarOrganizationMigration(
                { viewInline: true },
                settingsDefaults.sidebarOrganization,
                legacyOrganization,
            )).toEqual({ organization: legacyOrganization, shouldUpload: true });
        });

        it('does not resurrect legacy data when the database explicitly contains an empty organization', () => {
            expect(resolveSidebarOrganizationMigration(
                { sidebarOrganization: { lists: [], tags: [], sessions: {} } },
                settingsDefaults.sidebarOrganization,
                legacyOrganization,
            )).toEqual({ organization: settingsDefaults.sidebarOrganization, shouldUpload: false });
        });

        it('does not treat a present future-format database payload as missing migration data', () => {
            expect(resolveSidebarOrganizationMigration(
                { sidebarOrganization: { lists: 'broken', tags: [], sessions: {} } },
                settingsDefaults.sidebarOrganization,
                legacyOrganization,
            )).toEqual({ organization: settingsDefaults.sidebarOrganization, shouldUpload: false });
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

        it('preserves future-format sidebar records while syncing known records', () => {
            const futureList = {
                id: 'future-list',
                name: 'Future',
                kind: 'smart-folder',
                color: 'blue',
                createdAt: 2,
                query: { unread: true },
            };
            const parsed = settingsParse({
                sidebarOrganization: {
                    lists: [futureList],
                    tags: [],
                    sessions: {},
                },
            });
            const knownList = {
                id: 'known-list',
                name: 'Known',
                kind: 'agent' as const,
                color: 'green' as const,
                createdAt: 3,
            };

            const payload = settingsToSyncPayload({
                ...parsed,
                sidebarOrganization: { lists: [knownList], tags: [], sessions: {} },
            });

            expect(payload.sidebarOrganization?.lists).toEqual([knownList, futureList]);
            expect(payload).not.toHaveProperty('sidebarOrganizationRaw');
        });

        it('preserves additive future fields on known sidebar records', () => {
            const rawOrganization = {
                lists: [{
                    id: 'known-list',
                    name: 'Known',
                    kind: 'agent' as const,
                    color: 'green' as const,
                    createdAt: 3,
                    query: { unread: true },
                }],
                tags: [{
                    id: 'known-tag',
                    name: 'Known tag',
                    color: 'blue' as const,
                    createdAt: 4,
                    icon: 'sparkles',
                }],
                sessions: {
                    'session-1': {
                        listId: 'known-list',
                        tagIds: ['known-tag'],
                        pinned: true,
                    },
                },
                smartFoldersVersion: 2,
            };

            const parsed = settingsParse({ sidebarOrganization: rawOrganization });
            const payload = settingsToSyncPayload(parsed);

            expect(parsed.sidebarOrganizationRaw).toBeNull();
            expect(payload.sidebarOrganization).toEqual(rawOrganization);
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
