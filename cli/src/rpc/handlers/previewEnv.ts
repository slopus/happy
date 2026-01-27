import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { isValidEnvVarKey, sanitizeEnvVarRecord } from '@/terminal/envVarSanitization';
import { RPC_METHODS } from '@happy/protocol/rpc';

type EnvPreviewSecretsPolicy = 'none' | 'redacted' | 'full';

interface PreviewEnvRequest {
    keys: string[];
    extraEnv?: Record<string, string>;
    /**
     * Keys that should be treated as sensitive at minimum (UI/user/docs provided).
     * The daemon may still treat additional keys as sensitive via its own heuristics.
     */
    sensitiveKeys?: string[];
}

type PreviewEnvSensitivitySource = 'forced' | 'hinted' | 'none';

interface PreviewEnvValue {
    value: string | null;
    isSet: boolean;
    isSensitive: boolean;
    /**
     * True when sensitivity is enforced by daemon heuristics (not overridable by UI).
     */
    isForcedSensitive: boolean;
    sensitivitySource: PreviewEnvSensitivitySource;
    display: 'full' | 'redacted' | 'hidden' | 'unset';
}

interface PreviewEnvResponse {
    policy: EnvPreviewSecretsPolicy;
    values: Record<string, PreviewEnvValue>;
}

function normalizeSecretsPolicy(raw: unknown): EnvPreviewSecretsPolicy {
    if (typeof raw !== 'string') return 'none';
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'none' || normalized === 'redacted' || normalized === 'full') return normalized;
    return 'none';
}

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function redactSecret(value: string): string {
    const len = value.length;
    if (len <= 0) return '';
    if (len <= 2) return '*'.repeat(len);

    // Hybrid: percentage with min/max caps (credit-card style).
    const ratio = 0.2;
    const startRaw = Math.ceil(len * ratio);
    const endRaw = Math.ceil(len * ratio);

    let start = clampInt(startRaw, 1, 6);
    let end = clampInt(endRaw, 1, 6);

    // Ensure we always have at least 1 masked character (when possible).
    if (start + end >= len) {
        // Keep start/end small enough to leave room for masking.
        // Prefer preserving start, then reduce end.
        end = Math.max(0, len - start - 1);
        if (end < 1) {
            start = Math.max(0, len - 2);
            end = Math.max(0, len - start - 1);
        }
    }

    const maskedLen = Math.max(0, len - start - end);
    const prefix = value.slice(0, start);
    const suffix = end > 0 ? value.slice(len - end) : '';
    return `${prefix}${'*'.repeat(maskedLen)}${suffix}`;
}

export function registerPreviewEnvHandler(rpcHandlerManager: RpcHandlerManager): void {
    // Environment preview handler - returns daemon-effective env values with secret policy applied.
    //
    // This is the recommended way for the UI to preview what a spawned session will receive:
    // - Uses daemon process.env as the base
    // - Optionally applies profile-provided extraEnv with the same ${VAR} expansion semantics used for spawns
    // - Applies daemon-controlled secret visibility policy (HAPPY_ENV_PREVIEW_SECRETS)
    rpcHandlerManager.registerHandler<PreviewEnvRequest, PreviewEnvResponse>(RPC_METHODS.PREVIEW_ENV, async (data) => {
        const keys = Array.isArray(data?.keys) ? data.keys : [];
        const maxKeys = 200;
        const trimmedKeys = keys.slice(0, maxKeys);
        for (const key of trimmedKeys) {
            if (typeof key !== 'string' || !isValidEnvVarKey(key)) {
                throw new Error(`Invalid env var key: "${String(key)}"`);
            }
        }

        const policy = normalizeSecretsPolicy(process.env.HAPPY_ENV_PREVIEW_SECRETS);
        const sensitiveKeys = Array.isArray(data?.sensitiveKeys)
            ? data.sensitiveKeys.filter((k): k is string => typeof k === 'string' && isValidEnvVarKey(k))
            : [];
        const sensitiveKeySet = new Set(sensitiveKeys);

        const extraEnv = sanitizeEnvVarRecord(data?.extraEnv);

        const expandedExtraEnv = Object.keys(extraEnv).length > 0
            ? expandEnvironmentVariables(extraEnv, process.env, { warnOnUndefined: false })
            : {};
        const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...expandedExtraEnv };

        const defaultSecretNameRegex = /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i;
        const overrideRegexRaw = process.env.HAPPY_ENV_PREVIEW_SECRET_NAME_REGEX;
        const secretNameRegex = (() => {
            if (typeof overrideRegexRaw !== 'string') return defaultSecretNameRegex;
            const trimmed = overrideRegexRaw.trim();
            if (!trimmed) return defaultSecretNameRegex;
            try {
                return new RegExp(trimmed, 'i');
            } catch {
                return defaultSecretNameRegex;
            }
        })();

        const values: Record<string, PreviewEnvValue> = {};
        for (const key of trimmedKeys) {
            const rawValue = effectiveEnv[key];
            const isSet = typeof rawValue === 'string';
            const isForcedSensitive = secretNameRegex.test(key);
            const hintedSensitive = sensitiveKeySet.has(key);
            const isSensitive = isForcedSensitive || hintedSensitive;
            const sensitivitySource: PreviewEnvSensitivitySource = isForcedSensitive
                ? 'forced'
                : hintedSensitive
                    ? 'hinted'
                    : 'none';

            if (!isSet) {
                values[key] = {
                    value: null,
                    isSet: false,
                    isSensitive,
                    isForcedSensitive,
                    sensitivitySource,
                    display: 'unset',
                };
                continue;
            }

            if (!isSensitive) {
                values[key] = {
                    value: rawValue,
                    isSet: true,
                    isSensitive: false,
                    isForcedSensitive: false,
                    sensitivitySource: 'none',
                    display: 'full',
                };
                continue;
            }

            if (policy === 'none') {
                values[key] = {
                    value: null,
                    isSet: true,
                    isSensitive: true,
                    isForcedSensitive,
                    sensitivitySource,
                    display: 'hidden',
                };
            } else if (policy === 'redacted') {
                values[key] = {
                    value: redactSecret(rawValue),
                    isSet: true,
                    isSensitive: true,
                    isForcedSensitive,
                    sensitivitySource,
                    display: 'redacted',
                };
            } else {
                values[key] = {
                    value: rawValue,
                    isSet: true,
                    isSensitive: true,
                    isForcedSensitive,
                    sensitivitySource,
                    display: 'full',
                };
            }
        }

        return { policy, values };
    });
}
