/**
 * Centralized canned (fixed-text) speech for the voice assistant.
 * All short, predictable responses live here for easy maintenance.
 */

type LangMap = Record<string, string>;

const DEFAULT_LANG = 'en';

// ---------------------------------------------------------------------------
// Tool follow-up — skip LLM for predictable tool results
// ---------------------------------------------------------------------------

/**
 * Tools whose successful result needs no LLM interpretation.
 * Key = tool name, value = { lang → speech }.
 */
export const CANNED_TOOL_SPEECH: Record<string, LangMap> = {
    messageClaudeCode:        { zh: '已发送', en: 'Sent', ja: '送信しました', ko: '전송했습니다' },
    processPermissionRequest: { zh: '好', en: 'Done', ja: 'はい', ko: '네' },
    changeSessionSettings:    { zh: '设置好了', en: 'Settings updated', ja: '設定しました', ko: '설정 완료' },
    navigateHome:             { zh: '已回到首页', en: 'Back to home', ja: 'ホームに戻りました', ko: '홈으로 돌아갔습니다' },
};

// ---------------------------------------------------------------------------
// Background session notification
// ---------------------------------------------------------------------------

export const BACKGROUND_READY_SPEECH: LangMap = {
    zh: '有个会话处理完了',
    en: 'A session just finished',
    ja: 'セッションが完了しました',
    ko: '세션이 완료됐어요',
};

export const BACKGROUND_PERMISSION_SPEECH: LangMap = {
    zh: '有个会话需要授权',
    en: 'A session needs approval',
    ja: 'セッションが承認待ちです',
    ko: '세션이 승인 대기 중이에요',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ERROR_SIGNAL_REGEX = /error|fail|timeout|not found/i;
const CANCEL_SIGNAL_REGEX = /cancel/i;

/** Canned speech for cancelled tool results (currently only messageClaudeCode). */
const CANNED_CANCEL_SPEECH: Record<string, LangMap> = {
    messageClaudeCode: { zh: '已取消', en: 'Cancelled', ja: 'キャンセルしました', ko: '취소했습니다' },
};

/**
 * Returns a canned speech string for a tool follow-up, or null if the tool
 * result should go through the LLM (unknown tool, or result contains errors).
 */
export function tryGetCannedToolResponse(
    toolName: string,
    toolResult: string,
    languagePreference: string,
): string | null {
    const lang = (languagePreference || DEFAULT_LANG).slice(0, 2).toLowerCase();

    // Cancelled results get their own canned speech
    if (CANCEL_SIGNAL_REGEX.test(toolResult)) {
        const cancelSpeeches = CANNED_CANCEL_SPEECH[toolName];
        if (cancelSpeeches) return cancelSpeeches[lang] ?? cancelSpeeches[DEFAULT_LANG] ?? null;
        return null;
    }

    const speeches = CANNED_TOOL_SPEECH[toolName];
    if (!speeches) return null;
    if (ERROR_SIGNAL_REGEX.test(toolResult)) return null;
    return speeches[lang] ?? speeches[DEFAULT_LANG] ?? null;
}

/**
 * Returns the background-session-ready speech for the given language.
 */
export function getBackgroundReadySpeech(languagePreference: string): string {
    const lang = (languagePreference || DEFAULT_LANG).slice(0, 2).toLowerCase();
    return BACKGROUND_READY_SPEECH[lang] ?? BACKGROUND_READY_SPEECH[DEFAULT_LANG]!;
}

export function getBackgroundPermissionSpeech(languagePreference: string): string {
    const lang = (languagePreference || DEFAULT_LANG).slice(0, 2).toLowerCase();
    return BACKGROUND_PERMISSION_SPEECH[lang] ?? BACKGROUND_PERMISSION_SPEECH[DEFAULT_LANG]!;
}
