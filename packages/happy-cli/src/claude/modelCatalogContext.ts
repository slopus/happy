import { createHash } from 'node:crypto';

const connectionKeys = /^(ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN|MODEL|DEFAULT_.*_MODEL)|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|VERTEX_|CLOUD_ML_)/;
const selectedEnv = (env: Record<string, unknown>) => Object.fromEntries(Object.entries(env).filter(([key]) => connectionKeys.test(key)).sort(([a], [b]) => a.localeCompare(b)));
const concreteSecret = (value: unknown) => typeof value === 'string' && value.length > 0 && !/redacted|masked|^\*+$/i.test(value);

/** Effective per-child settings stay in memory; only their opaque identity is retained. */
export function claudeModelConnection(settings: any, env: NodeJS.ProcessEnv, executable: string | undefined, account: any): string | undefined {
    const effective = settings?.effective;
    if (!executable || !effective || typeof effective !== 'object' || Array.isArray(effective) || effective.apiKeyHelper) return undefined;
    const settingEnv = effective.env ?? {};
    const explicitCredential = concreteSecret(settingEnv.ANTHROPIC_AUTH_TOKEN) || concreteSecret(settingEnv.ANTHROPIC_API_KEY)
        || concreteSecret(env.ANTHROPIC_AUTH_TOKEN) || concreteSecret(env.ANTHROPIC_API_KEY);
    const knownOAuth = account?.apiProvider === 'firstParty' && account?.email && account?.organization && !account?.apiKeySource;
    if (!explicitCredential && !knownOAuth) return undefined;
    if (account?.apiProvider && !['firstParty', 'gateway'].includes(account.apiProvider)) return undefined;
    const context = { executable, env: selectedEnv(env), settingsEnv: selectedEnv(settingEnv),
        model: effective.model, modelOverrides: effective.modelOverrides, modelSettings: effective.modelSettings,
        account: knownOAuth ? [account.apiProvider, account.email, account.organization] : null };
    return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

/** Optional native control: older CLIs remain usable without claiming a verified fresh connection. */
export async function readClaudeModelConnection(query: object, env: NodeJS.ProcessEnv, executable: string | undefined, account: unknown): Promise<string | undefined> {
    const control = query as { getSettings?: () => Promise<unknown> };
    if (typeof control.getSettings !== 'function') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const settings = await Promise.race([control.getSettings(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Claude settings control timed out')), 2_000);
        })]);
        return claudeModelConnection(settings, env, executable, account);
    } catch { return undefined; }
    finally { if (timer) clearTimeout(timer); }
}
