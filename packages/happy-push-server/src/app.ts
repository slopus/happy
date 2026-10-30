import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { Env } from '@/env';
import { sendPushMessages } from '@/push/send';
import { MAX_RECIPIENTS_PER_REQUEST, pushRequestSchema, registerRequestSchema, unregisterRequestSchema } from '@/schema';
import { deactivateDevice, upsertDevice } from '@/storage/devices';
import { formatPushToken } from '@/token';
import { isWithinLimit } from '@/utils/rateLimit';

type AppContext = Context<{ Bindings: Env }>;

const REGISTER_BODY_LIMIT = 16 * 1024;
const SEND_BODY_LIMIT = 1024 * 1024;

export function createApp() {
    const app = new Hono<{ Bindings: Env }>();

    app.get('/health', (c) => c.json({ ok: true }));

    // Public: called by the mobile app, which holds no secret. Same trust
    // model as Expo's registration: the random deviceId is the credential.
    app.post('/v1/devices/register', limitRegistration(), limitBody(REGISTER_BODY_LIMIT), async (c) => {
        const parsed = await parseBody(c, registerRequestSchema);
        if (!parsed.ok) {
            return parsed.response;
        }
        const input = parsed.value;
        if (!isAppAllowed(c.env, input.appId)) {
            return errorResponse(c, 403, 'APP_NOT_ALLOWED', `appId "${input.appId}" is not allowed to register`);
        }

        const id = await upsertDevice(c.env.DB, {
            appId: input.appId,
            deviceId: input.deviceId,
            platform: input.platform,
            provider: input.provider,
            // APNs sandbox vs production; FCM and Expo have no such split.
            environment: input.provider === 'apns' ? input.environment ?? 'production' : 'production',
            // APNs accepts either case; normalizing keeps dedupe exact.
            pushToken: input.provider === 'apns' ? input.pushToken.toLowerCase() : input.pushToken,
            metadata: input.metadata,
        }, Date.now());
        return c.json({ token: formatPushToken(id) });
    });

    app.post('/v1/devices/unregister', limitRegistration(), limitBody(REGISTER_BODY_LIMIT), async (c) => {
        const parsed = await parseBody(c, unregisterRequestSchema);
        if (!parsed.ok) {
            return parsed.response;
        }
        if (!isAppAllowed(c.env, parsed.value.appId)) {
            return errorResponse(c, 403, 'APP_NOT_ALLOWED', `appId "${parsed.value.appId}" is not allowed`);
        }
        // Same answer whether or not the install exists.
        await deactivateDevice(c.env.DB, parsed.value.appId, parsed.value.deviceId, Date.now());
        return c.json({ ok: true });
    });

    // Unauthenticated, like Expo's default: the unguessable push token is
    // the capability. Abuse is bounded per recipient in sendPushMessages.
    // Tickets keep Expo's shape and error codes so happy-server's
    // DeviceNotRegistered cleanup works unchanged.
    app.post('/v1/push/send', limitBody(SEND_BODY_LIMIT), async (c) => {
        const parsed = await parseBody(c, pushRequestSchema);
        if (!parsed.ok) {
            return parsed.response;
        }
        const messages = parsed.value;
        const recipientCount = messages.reduce((sum, m) => sum + (Array.isArray(m.to) ? m.to.length : 1), 0);
        if (recipientCount > MAX_RECIPIENTS_PER_REQUEST) {
            return errorResponse(c, 400, 'PUSH_TOO_MANY_NOTIFICATIONS',
                `Requests may address at most ${MAX_RECIPIENTS_PER_REQUEST} recipients; got ${recipientCount}`);
        }

        return c.json({ data: await sendPushMessages(c.env, messages) });
    });

    app.notFound((c) => errorResponse(c, 404, 'NOT_FOUND', 'Not found'));
    app.onError((error, c) => {
        console.error(`push: unhandled error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        return errorResponse(c, 500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
    });

    return app;
}

/** Every error uses one `{ errors: [{ code, message, details? }] }` envelope. */
function errorResponse(c: AppContext, status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    return c.json({ errors: [{ code, message, ...(details === undefined ? {} : { details }) }] }, status);
}

/**
 * Per-client-IP limit on the public device routes. Clients register on launch
 * and on token rotation, so a legitimate IP (even a carrier NAT) stays far
 * below it; it exists to stop one host from churning the devices table.
 */
function limitRegistration(): MiddlewareHandler<{ Bindings: Env }> {
    return async (c, next) => {
        const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
        if (!(await isWithinLimit(c.env.REGISTER_RATE_LIMITER, `register:${ip}`))) {
            return errorResponse(c, 429, 'RATE_LIMITED', 'Too many registration requests; retry in a minute');
        }
        return next();
    };
}

function limitBody(maxSize: number) {
    return bodyLimit({
        maxSize,
        onError: (c) => errorResponse(c as AppContext, 413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxSize} bytes`),
    });
}

async function parseBody<S extends z.ZodType>(
    c: AppContext,
    schema: S
): Promise<{ ok: true; value: z.output<S> } | { ok: false; response: Response }> {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch (error) {
        // bodyLimit can only count bytes as they stream in when there is no
        // Content-Length, so an oversized chunked body surfaces here.
        if (error instanceof Error && error.name === 'BodyLimitError') {
            return { ok: false, response: errorResponse(c, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large') };
        }
        return { ok: false, response: errorResponse(c, 400, 'VALIDATION_ERROR', 'Request body must be JSON') };
    }
    const result = schema.safeParse(body);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
        return { ok: false, response: errorResponse(c, 400, 'VALIDATION_ERROR', 'Request body is invalid', issues) };
    }
    return { ok: true, value: result.data };
}

function isAppAllowed(env: Env, appId: string): boolean {
    const allowed = (env.ALLOWED_APP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return allowed.length === 0 || allowed.includes(appId);
}
