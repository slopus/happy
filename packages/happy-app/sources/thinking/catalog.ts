import library from './frameworks.json';

export const METHOD_IDS = ['socratic', 'two-layer', 'reverse-engineer', 'vertical-horizontal', 'fact-check', 'expert-panel', 'first-principles', 'cross-domain', 'steelman', 'min-experiment', 'hidden-talent', 'life-design', 'teach-me'] as const;
export type ThinkingMethodId = typeof METHOD_IDS[number];
export const GROUP_IDS = ['clarify', 'learn', 'solve', 'decide', 'life'] as const;
export type ThinkingGroup = typeof GROUP_IDS[number];
export type ThinkingKind = 'direct' | 'guided' | 'two_phase' | 'learning';
const groups: Record<ThinkingMethodId, ThinkingGroup> = {
    socratic: 'clarify', 'fact-check': 'clarify', 'two-layer': 'learn',
    'reverse-engineer': 'learn', 'vertical-horizontal': 'learn', 'teach-me': 'learn',
    'expert-panel': 'solve', 'first-principles': 'solve', 'cross-domain': 'solve',
    steelman: 'decide', 'min-experiment': 'decide', 'hidden-talent': 'life', 'life-design': 'life',
};
export const TEACH_ME_INSTRUCTION = 'Use the current conversation to identify the concept the user is learning. Start from their demonstrated knowledge and experience, then explain the key mechanism with a concrete transferable example. Continue the same learning topic across turns and build on actual previous replies; do not restart onboarding. If the user has named what is unclear, explain it directly. Ask at most one relevant question only when the answer would materially change the explanation. Do not impose quizzes or repeatedly ask whether they understand. Optional self-checks and exercises are requested by the user; never infer mastery from silence.';

export const THINKING_METHODS = METHOD_IDS.map(id => {
    const framework = library.frameworks.find(method => method.id === id);
    return {
        id, group: groups[id], kind: (id === 'teach-me' ? 'learning' : framework!.kind) as ThinkingKind,
        number: framework?.number,
        originalPrompt: framework?.originalPrompt ?? TEACH_ME_INSTRUCTION,
        originalPromptEn: framework?.originalPromptEn ?? TEACH_ME_INSTRUCTION,
        adaptation: framework?.pawsAdaptation ?? '',
    };
});
export const THINKING_SOURCE = library.source;
export function isThinkingMethod(value: unknown): value is ThinkingMethodId {
    return METHOD_IDS.includes(value as ThinkingMethodId);
}
