import { describe, expect, it } from 'vitest';
import { resolveRunningSessionTurnModes } from './runningSessionTurnModes';

const translate = (key: string) => key;

describe('resolveRunningSessionTurnModes', () => {
    it('keeps the running connection catalog without fabricated suggestions', () => {
        const session = {
            modelMode: null, effortLevel: 'medium',
            metadata: {
                flavor: 'codex', currentModelCode: 'gpt-6-astra',
                models: [
                    { code: 'gpt-6-astra', value: 'gpt-6-astra', description: 'Frontier intelligence' },
                    { code: 'gpt-5.6-sol', value: 'gpt-5.6-sol' },
                    { code: 'gpt-5.6-terra', value: 'gpt-5.6-terra' },
                    { code: 'gpt-5.6-luna', value: 'gpt-5.6-luna' },
                ],
            },
        } as any;
        const result = resolveRunningSessionTurnModes({ session, agentDefaultOverrides: {}, translate });
        expect(result.availableModels.map((model) => model.key)).toEqual([
            'gpt-6-astra',
            'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
        ]);
        expect(result.modelMode?.key).toBe('gpt-6-astra');
        expect(result.availableModels[0].description).toBe('Frontier intelligence');
        for (const modelMode of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
            const selected = resolveRunningSessionTurnModes({
                session: { ...session, modelMode }, agentDefaultOverrides: {}, translate,
            });
            expect(selected.modelMode?.key).toBe(modelMode);
            expect(selected.effortLevel?.key).toBe('medium');
            expect(selected.availableEffortLevels.at(-1)?.key).toBe('ultra');
        }
    });

    it('labels a native reset honestly without exposing it as a model choice', async () => {
        const { resolveMessageModeMeta } = await import('@/sync/messageMeta');
        const session = { modelMode: 'default', effortLevel: 'medium', metadata: {
            flavor: 'codex', currentModelCode: 'gemini-custom',
            models: [{ code: 'gemini-custom', value: 'Gemini Custom' }],
        } } as any;
        const result = resolveRunningSessionTurnModes({ session, agentDefaultOverrides: {}, translate });
        expect(result.modelMode).toEqual({ key: 'default', name: 'agentInput.model.cliAutomatic' });
        expect(result.availableModels.map(model => model.key)).toEqual(['gemini-custom']);
        expect(resolveMessageModeMeta(session).model).toBeNull();
    });

    it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])('keeps supported Ultra for %s in both picker and outgoing message', async (modelMode) => {
        const { resolveMessageModeMeta } = await import('@/sync/messageMeta');
        for (const effortLevel of ['ultra', null]) {
            const session = { modelMode, effortLevel, metadata: {
                flavor: 'codex', currentModelCode: 'gpt-6-astra', currentThoughtLevelCode: 'ultra',
            } } as any;
            const result = resolveRunningSessionTurnModes({ session, agentDefaultOverrides: {}, translate });
            expect(result.effortLevel?.key).toBe('ultra');
            expect(resolveMessageModeMeta(session).effort).toBe('ultra');
        }
    });

    it('prefers explicit per-session model and effort for the next turn', () => {
        const result = resolveRunningSessionTurnModes({
            session: {
                modelMode: 'gpt-5.6-sol',
                effortLevel: 'xhigh',
                metadata: { flavor: 'codex' },
            } as any,
            agentDefaultOverrides: {
                codex: { modelMode: 'gpt-5.5', effortLevel: 'medium' },
            },
            translate,
        });

        expect(result.modelMode).toMatchObject({ key: 'gpt-5.6-sol', name: 'gpt-5.6-sol' });
        expect(result.effortLevel).toMatchObject({ key: 'xhigh', name: 'xhigh' });
    });

    it('keeps a CLI-reported model visible even before the fallback catalog knows it', () => {
        const result = resolveRunningSessionTurnModes({
            session: {
                modelMode: null,
                effortLevel: null,
                metadata: {
                    flavor: 'codex',
                    currentModelCode: 'gpt-future',
                    currentThoughtLevelCode: 'high',
                },
            } as any,
            agentDefaultOverrides: {},
            translate,
        });

        expect(result.availableModels.map(model => model.key)).toEqual(['gpt-future']);
        expect(result.modelMode).toEqual({ key: 'gpt-future', name: 'gpt-future' });
        expect(result.effortLevel?.key).toBe('high');
    });

    it('keeps an explicit effort reset visible and otherwise uses a supported effort when medium is unavailable', async () => {
        const { resolveMessageModeMeta } = await import('@/sync/messageMeta');
        const session = { modelMode: 'gpt-custom', effortLevel: 'default', metadata: {
            flavor: 'codex', currentModelCode: 'gpt-custom', thoughtLevels: [
                { code: 'high', value: 'high' }, { code: 'max', value: 'max' },
            ],
        } } as any;
        expect(resolveRunningSessionTurnModes({ session, agentDefaultOverrides: {}, translate }).effortLevel?.key).toBe('default');
        expect(resolveMessageModeMeta(session).effort).toBeNull();
        const withoutExplicitEffort = { ...session, effortLevel: null };
        expect(resolveRunningSessionTurnModes({ session: withoutExplicitEffort, agentDefaultOverrides: {}, translate }).effortLevel?.key).toBe('high');
        expect(resolveMessageModeMeta(withoutExplicitEffort).effort).toBe('high');
    });

    it('does not offer fallback GPT models while the session catalog is unknown', () => {
        const result = resolveRunningSessionTurnModes({
            session: { modelMode: null, effortLevel: null, metadata: { flavor: 'codex' } } as any,
            agentDefaultOverrides: {}, translate,
        });
        expect(result.availableModels).toEqual([]);
    });

    it('uses Codex model and effort defaults', () => {
        const result = resolveRunningSessionTurnModes({
            session: {
                modelMode: null,
                effortLevel: null,
                metadata: { flavor: 'codex' },
            } as any,
            agentDefaultOverrides: {},
            translate,
        });

        expect(result.modelMode?.key).toBe('gpt-6.1-sol');
        expect(result.effortLevel?.key).toBe('medium');
    });

    it('only enables Fast for the selected Codex model priority tier', () => {
        const metadata = {
            flavor: 'codex',
            models: [
                { code: 'gpt-5.6-sol', value: 'gpt-5.6-sol', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
                { code: 'gpt-5.5', value: 'gpt-5.5' },
            ],
        };

        expect(resolveRunningSessionTurnModes({
            session: { modelMode: 'gpt-5.6-sol', effortLevel: null, metadata } as any,
            agentDefaultOverrides: {},
            translate,
        }).supportsFast).toBe(true);

        expect(resolveRunningSessionTurnModes({
            session: { modelMode: 'gpt-5.5', effortLevel: null, metadata } as any,
            agentDefaultOverrides: {},
            translate,
        }).supportsFast).toBe(false);
    });

    it('drops stale effort state for an agent that does not expose effort options', () => {
        const result = resolveRunningSessionTurnModes({
            session: {
                modelMode: null,
                effortLevel: 'xhigh',
                metadata: { flavor: 'opencode' },
            } as any,
            agentDefaultOverrides: {},
            translate,
        });

        expect(result.availableEffortLevels).toEqual([]);
        expect(result.effortLevel).toBeNull();
    });
});

it('reads retired Ask model metadata without resolving runnable defaults', () => {
    expect(resolveRunningSessionTurnModes({ session: { metadata: { flavor: 'ask', currentModelCode: 'legacy-model' } } as any, agentDefaultOverrides: {}, translate })).toEqual({ availableModels: [], modelMode: { key: 'legacy-model', name: 'legacy-model' }, availableEffortLevels: [], effortLevel: null, supportsFast: false });
});
