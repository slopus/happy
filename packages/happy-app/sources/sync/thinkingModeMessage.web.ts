import { getCurrentLanguage } from '@/text';
import { buildThinkingPrompt } from '@/thinking/prompts';
import { hasThinkingHistory, selectedThinkingMethod, thinkingEnabled } from '@/thinking/preferences.web';

export function prepareThinkingMessage(sessionId: string, text: string): string {
    if (text.trimStart().startsWith('/')) return text;
    const method = thinkingEnabled() ? selectedThinkingMethod(sessionId) : null;
    if (method) return buildThinkingPrompt(text, method, getCurrentLanguage().startsWith('zh'));
    // An explicit cancellation/off switch must also release the previous turn's instruction.
    return hasThinkingHistory(sessionId)
        ? `Paws thinking mode is not selected for this turn. Follow the user's current request normally; do not continue a previously selected thinking framework unless the user asks.\n\n${text}`
        : text;
}
