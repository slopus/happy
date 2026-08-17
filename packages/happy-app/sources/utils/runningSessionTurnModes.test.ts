import { describe, expect, it } from 'vitest';
import { resolveRunningSessionTurnModes } from './runningSessionTurnModes';

const translate = (key: string) => key;

describe('resolveRunningSessionTurnModes', () => {
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

    it('shows Codex default effort as an explicit picker value', () => {
        const result = resolveRunningSessionTurnModes({
            session: {
                modelMode: null,
                effortLevel: null,
                metadata: { flavor: 'codex' },
            } as any,
            agentDefaultOverrides: {},
            translate,
        });

        expect(result.modelMode?.key).toBe('default');
        expect(result.effortLevel).toMatchObject({ key: 'default', name: 'default effort' });
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
