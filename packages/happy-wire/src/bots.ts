import { z } from 'zod';

export function isBotsOrigin(value: string): boolean {
    try {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash
            && url.pathname === '/' && (value === url.origin || value === `${url.origin}/`)
            && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
    } catch { return false; }
}

export const BotsLaunchRequestSchema = z.object({
    parentOrigin: z.string().max(2048).refine(isBotsOrigin, 'Expected an HTTPS origin (loopback HTTP is allowed for development)'),
    platform: z.enum(['web', 'native']).default('web'),
    locale: z.enum(['en', 'zh']).optional(),
    appearance: z.enum(['light', 'dark', 'system']).optional(),
}).strict();

export const BotsLaunchResponseSchema = z.object({
    runtimeUrl: z.string().refine((value) => isBotsOrigin(value) && value.endsWith('/'), 'Expected a root runtime URL'),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().int().positive(),
}).strict();

export type BotsLaunchRequest = z.infer<typeof BotsLaunchRequestSchema>;
export type BotsLaunchResponse = z.infer<typeof BotsLaunchResponseSchema>;
