import { z } from 'zod';

const metadataString = z.string().max(128);

/** 'ios' means APNs: iOS, iPadOS and macOS apps all register as 'ios'. */
export const platformSchema = z.enum(['ios', 'android']);
export type Platform = z.infer<typeof platformSchema>;

export const apnsEnvironmentSchema = z.enum(['production', 'development']);
export type ApnsEnvironment = z.infer<typeof apnsEnvironmentSchema>;

/**
 * Lowercased, as Expo does: Swift's UUID().uuidString is uppercase while JS
 * randomUUID() is lowercase, and both must name the same install.
 */
export const deviceIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'deviceId has invalid characters')
    .transform((value) => value.toLowerCase());

/** Bundle id / Android package. Also used as the APNs topic. */
export const appIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'appId has invalid characters');

export const deviceMetadataSchema = z.object({
    deviceName: metadataString.optional(),
    deviceModel: metadataString.optional(),
    osName: metadataString.optional(),
    osVersion: metadataString.optional(),
    appVersion: metadataString.optional(),
    appBuild: metadataString.optional(),
    locale: metadataString.optional(),
    timezone: metadataString.optional(),
});
export type DeviceMetadata = z.infer<typeof deviceMetadataSchema>;

/**
 * How an install is delivered to: natively over APNs or FCM, or forwarded to
 * Expo's push service for apps that only have an Expo push token so far.
 */
export const pushProviderSchema = z.enum(['apns', 'fcm', 'expo']);
export type PushProvider = z.infer<typeof pushProviderSchema>;

const nativeProviderFor: Record<Platform, PushProvider> = { ios: 'apns', android: 'fcm' };

// APNs device tokens are 32 bytes today; Apple reserves the right to grow
// them, so accept up to 100 bytes of hex.
const tokenSchemas: Record<PushProvider, z.ZodType<string>> = {
    apns: z.string().regex(/^[0-9a-fA-F]{64,200}$/, 'pushToken must be an APNs device token in hex'),
    fcm: z.string().min(32).max(1024).regex(/^[A-Za-z0-9_:-]+$/, 'pushToken must be an FCM registration token'),
    expo: z.string().max(256).regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/, 'pushToken must be an Expo push token'),
};

export const registerRequestSchema = z.preprocess(
    // `nativeToken` is the field's first name; requests using it stay valid.
    (body) => {
        if (body && typeof body === 'object' && !Array.isArray(body) && !('pushToken' in body) && 'nativeToken' in body) {
            const { nativeToken, ...rest } = body as Record<string, unknown>;
            return { ...rest, pushToken: nativeToken };
        }
        return body;
    },
    z.object({
        deviceId: deviceIdSchema,
        appId: appIdSchema,
        platform: platformSchema,
        /** Defaults to the platform's native provider: apns for ios, fcm for android. */
        provider: pushProviderSchema.optional(),
        pushToken: z.string(),
        environment: apnsEnvironmentSchema.optional(),
        metadata: deviceMetadataSchema.optional(),
    }).superRefine((value, ctx) => {
        const provider = value.provider ?? nativeProviderFor[value.platform];
        if (provider !== 'expo' && provider !== nativeProviderFor[value.platform]) {
            ctx.addIssue({ code: 'custom', path: ['provider'], message: `provider "${provider}" does not deliver to ${value.platform}` });
            return;
        }
        const result = tokenSchemas[provider].safeParse(value.pushToken);
        if (!result.success) {
            ctx.addIssue({ code: 'custom', path: ['pushToken'], message: result.error.issues[0]?.message ?? 'invalid pushToken' });
        }
    }).transform((value) => ({ ...value, provider: value.provider ?? nativeProviderFor[value.platform] }))
);
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const unregisterRequestSchema = z.object({
    deviceId: deviceIdSchema,
    appId: appIdSchema,
});

export const MAX_RECIPIENTS_PER_REQUEST = 100;

const recipientSchema = z.string().max(256);

export const pushPrioritySchema = z.enum(['high', 'normal']);
export type PushPriority = z.infer<typeof pushPrioritySchema>;

/**
 * One notification to one or more recipients. Strict: an unknown field is a
 * sender bug, so it fails the request instead of being silently dropped.
 */
export const pushMessageSchema = z.strictObject({
    to: z.union([recipientSchema, z.array(recipientSchema).min(1).max(MAX_RECIPIENTS_PER_REQUEST)]),
    title: z.string().max(4096).optional(),
    subtitle: z.string().max(4096).optional(),
    body: z.string().max(4096).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    /** A bundled sound name, 'default', or null/omitted for silence on iOS. */
    sound: z.union([z.string().max(256), z.null()]).optional(),
    badge: z.number().int().min(0).optional(),
    channelId: z.string().max(256).optional(),
    categoryId: z.string().max(256).optional(),
    threadId: z.string().max(256).optional(),
    /** Defaults to 'high' for visible alerts and 'normal' for data-only pushes. */
    priority: pushPrioritySchema.optional(),
    /** Seconds the provider may hold an undeliverable message; 0 = deliver now or drop. */
    ttl: z.number().int().min(0).optional(),
    mutableContent: z.boolean().optional(),
    interruptionLevel: z.enum(['active', 'critical', 'passive', 'time-sensitive']).optional(),
    /** Also wake the app in the background for a visible alert (APNs content-available). */
    contentAvailable: z.boolean().optional(),
});
export type PushMessage = z.infer<typeof pushMessageSchema>;

export function hasVisibleAlert(message: PushMessage): boolean {
    return Boolean(message.title || message.subtitle || message.body);
}

export function resolvePriority(message: PushMessage): PushPriority {
    return message.priority ?? (hasVisibleAlert(message) ? 'high' : 'normal');
}

/** One message or an array; both normalize to an array here. */
export const pushRequestSchema = z.preprocess(
    (body) => Array.isArray(body) ? body : [body],
    z.array(pushMessageSchema).max(MAX_RECIPIENTS_PER_REQUEST)
);
