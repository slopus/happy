import { z } from 'zod';
import { type Fastify } from '../types';

export function featuresRoutes(app: Fastify) {
    app.get(
        '/v1/features',
        {
            schema: {
                response: {
                    200: z.object({
                        features: z.object({
                            sessionSharing: z.boolean(),
                            publicSharing: z.boolean(),
                            contentKeys: z.boolean(),
                        }),
                    }),
                },
            },
        },
        async (_request, reply) => {
            return reply.send({
                features: {
                    sessionSharing: true,
                    publicSharing: true,
                    contentKeys: true,
                },
            });
        }
    );
}

