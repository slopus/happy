import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { BrowserLocalSetup } from './browserLocalSetup'

/** All routes inherit the control server bearer and managed-runtime restrictions. */
export function attachBrowserLocalSetupRoutes(app: FastifyInstance, setup: BrowserLocalSetup) {
    const typed = app.withTypeProvider<ZodTypeProvider>()
    const scope = z.string().regex(/^bv1_[A-Za-z0-9_-]{32}$/)
    typed.post('/browser/local-setup/begin', { schema: { body: z.object({ viewerKey: scope, profile: z.string().min(1).max(128), extensionId: z.string().regex(/^[a-p]{32}$/).optional() }).strict() } },
        async request => setup.begin(request.body.viewerKey, request.body.profile, request.body.extensionId))
    typed.post('/browser/local-setup/status', { schema: { body: z.object({ viewerKey: scope }).strict() } },
        async request => setup.status(request.body.viewerKey))
    typed.post('/browser/local-setup/revoke', { schema: { body: z.object({ viewerKey: scope }).strict() } },
        async request => setup.revoke(request.body.viewerKey))
    typed.post('/browser/local-setup/consume', { schema: { body: z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict() } },
        async (request, reply) => {
            try { return { ok: true, config: await setup.consume(request.body.operationId) } }
            catch { reply.code(409); return { ok: false, error: 'SETUP_EXPIRED' } }
        })
}
