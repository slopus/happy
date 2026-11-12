import { describe, expect, it } from 'vitest';
import { resolveRunningSessionTurnModes } from './runningSessionTurnModes';

const translate = (key: string) => key;

describe('resolveRunningSessionTurnModes', () => {
    it('shows current Codex models in an existing session with a startup-time catalog', () => {
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
            'default', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna',
            'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
        ]);
        expect(result.modelMode?.key).toBe('gpt-6-astra');
        expect(result.availableModels[1].description).toBe('Frontier intelligence');
        for (const modelMode of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
            const selected = resolveRunningSessionTurnModes({
                session: { ...session, modelMode }, agentDefaultOverrides: {}, translate,
            });
            expect(selected.modelMode?.key).toBe(modelMode);
            expect(selected.effortLevel?.key).toBe('medium');
            expect(selected.availableEffortLevels.some((level) => level.key === 'ultra')).toBe(false);
        }
    });

    it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])('resets stale ultra for %s in both picker and outgoing message', async (modelMode) => {
        const { resolveMessageModeMeta } = await import('@/sync/messageMeta');
        for (const effortLevel of ['ultra', null]) {
            const session = { modelMode, effortLevel, metadata: {
                flavor: 'codex', currentModelCode: 'gpt-6-astra', currentThoughtLevelCode: 'ultra',
            } } as any;
            const result = resolveRunningSessionTurnModes({ session, agentDefaultOverrides: {}, translate });
            expect(result.effortLevel?.key).toBe('medium');
            expect(resolveMessageModeMeta(session).effort).toBe('medium');
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

        expect(result.availableModels.some((model) => model.key === 'gpt-future')).toBe(false);
        expect(result.modelMode).toEqual({ key: 'gpt-future', name: 'gpt-future' });
        expect(result.effortLevel?.key).toBe('high');
    });

    it('uses a supported effort when a model has no medium level', async () => {
        const { resolveMessageModeMeta } = await import('@/sync/messageMeta');
        const session = { modelMode: 'gpt-custom', effortLevel: 'default', metadata: {
            flavor: 'codex', currentModelCode: 'gpt-custom', thoughtLevels: [
                { code: 'high', value: 'high' }, { code: 'max', value: 'max' },
            ],
        } } as any;
        expect(resolveRunningSessionTurnModes({ session, agentDefaultOverrides: {}, translate }).effortLevel?.key).toBe('high');
        expect(resolveMessageModeMeta(session).effort).toBe('high');
        const withoutExplicitEffort = { ...session, effortLevel: null };
        expect(resolveRunningSessionTurnModes({ session: withoutExplicitEffort, agentDefaultOverrides: {}, translate }).effortLevel?.key).toBe('high');
        expect(resolveMessageModeMeta(withoutExplicitEffort).effort).toBe('high');
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
