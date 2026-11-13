/** Configuration for the native Paws Personal runtime; secrets remain in the environment. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { resolveDeepSeekApiKey } from '@/deepseek/deepseekCredentials';
import { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_FAST_MODEL } from '@/deepseek/deepseekClient';

const ConfigSchema = z.object({
    baseUrl: z.string().url().optional(),
    model: z.string().min(1).optional(),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    maxSteps: z.number().int().min(1).max(64).default(16),
}).strict();

export function personalHome(): string {
    return process.env.PAWS_PERSONAL_HOME || join(configuration.happyHomeDir, 'personal-agent');
}

export function loadPersonalConfig() {
    const path = join(personalHome(), 'config.json');
    const saved = ConfigSchema.parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
    const baseUrl = process.env.PAWS_PERSONAL_BASE_URL || saved.baseUrl || DEEPSEEK_DEFAULT_BASE_URL;
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Personal API URL must not contain credentials, a query or a fragment');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('Personal model API requires HTTPS, except for a local loopback gateway');
    }
    // Never forward an unrelated provider key to a custom gateway.
    const apiKey = process.env.PAWS_PERSONAL_API_KEY
        || (saved.apiKeyEnv ? process.env[saved.apiKeyEnv] : undefined)
        || (url.origin === new URL(DEEPSEEK_DEFAULT_BASE_URL).origin ? resolveDeepSeekApiKey().key : null);
    if (!apiKey && !loopback) throw new Error('Configure PAWS_PERSONAL_API_KEY or config.json apiKeyEnv for the Personal model API');
    return {
        baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: apiKey || undefined,
        model: process.env.PAWS_PERSONAL_MODEL || saved.model || DEEPSEEK_FAST_MODEL,
        maxSteps: saved.maxSteps,
    };
}

export type PersonalConfig = ReturnType<typeof loadPersonalConfig>;
