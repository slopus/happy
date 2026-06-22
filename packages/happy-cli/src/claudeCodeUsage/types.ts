/**
 * Public response shape for the `claude-code-usage:read` machine RPC.
 *
 * spec: specs/20260618-machine-cli-usage-quota/spec.md (R1 데이터 모델)
 */

export interface UsageWindow {
    usedPct: number;
    remainingPct: number;
    resetAtRaw: string;
    resetAt?: number;
}

export type ClaudeCodeSubscription = 'max' | 'pro' | 'team' | 'enterprise' | null;

/**
 * Discriminator for why no live gauges are available. The UI uses this
 * to choose between "미설치", "로그인 필요", "daemon 업그레이드", "조회
 * 실패" copy without trying to infer intent from a fuzzy `installed`
 * flag. `undefined` ⇒ live gauges are present.
 */
export type ClaudeCodeUsageErrorKind =
    | 'not-installed'
    | 'not-authenticated'
    | 'parse-failure'
    | 'transport'
    | 'daemon-upgrade-required'
    | 'offline';

export interface ClaudeCodeUsage {
    refreshedAt: number;
    installed: boolean;
    authenticated: boolean;
    subscriptionType?: ClaudeCodeSubscription;
    window5h?: UsageWindow;
    windowWeeklyAllModels?: UsageWindow;
    windowWeeklySonnet?: UsageWindow;
    errorKind?: ClaudeCodeUsageErrorKind;
    error?: string;
    cliVersion?: string;
    rawUsageOutput?: string;
}
