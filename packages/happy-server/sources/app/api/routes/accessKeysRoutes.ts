import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

export function accessKeysRoutes(app: Fastify) {
    // Get Access Key API
    app.get('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            response: {
                200: z.object({
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).nullable()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;

        try {
            // Verify session and machine belong to user
            const [session, machine] = await Promise.all([
                db.session.findFirst({
                    where: { id: sessionId, accountId: userId }
                }),
                db.machine.findFirst({
                    where: { id: machineId, accountId: userId }
                })
            ]);

            if (!session || !machine) {
                return reply.code(404).send({ error: 'Session or machine not found' });
            }

            // Get access key
            const accessKey = await db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId
                    }
                }
            });

            if (!accessKey) {
                return reply.send({ accessKey: null });
            }

            return reply.send({
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get access key: ${error}`);
            return reply.code(500).send({ error: 'Failed to get access key' });
        }
    });

    // Create Access Key API
    app.post('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            body: z.object({
                data: z.string()
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).optional(),
                    error: z.string().optional()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                409: z.object({
                    error: z.literal('Access key already exists')
                }),
                500: z.object({
                    error: z.literal('Failed to create access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data } = request.body;

        try {
            // Verify session and machine belong to user
            const [session, machine] = await Promise.all([
                db.session.findFirst({
                    where: { id: sessionId, accountId: userId }
                }),
                db.machine.findFirst({
                    where: { id: machineId, accountId: userId }
                })
            ]);

            if (!session || !machine) {
                return reply.code(404).send({ error: 'Session or machine not found' });
            }

            // Check if access key already exists
            const existing = await db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId
                    }
                }
            });

            if (existing) {
                return reply.code(409).send({ error: 'Access key already exists' });
            }

            // Create access key
            const accessKey = await db.accessKey.create({
                data: {
                    accountId: userId,
                    machineId,
                    sessionId,
                    data,
                    dataVersion: 1
                }
            });

            log({ module: 'access-keys', userId, sessionId, machineId }, 'Created new access key');

            return reply.send({
                success: true,
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to create access key: ${error}`);
            return reply.code(500).send({ error: 'Failed to create access key' });
        }
    });

    // Update Access Key API
    app.put('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            body: z.object({
                data: z.string(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        version: z.number()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentVersion: z.number(),
                        currentData: z.string()
                    })
                ]),
                404: z.object({
                    error: z.literal('Access key not found')
                }),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data, expectedVersion } = request.body;

        try {
            // Get current access key for version check
            const currentAccessKey = await db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId
                    }
                }
            });

            if (!currentAccessKey) {
                return reply.code(404).send({ error: 'Access key not found' });
            }

            // Check version
            if (currentAccessKey.dataVersion !== expectedVersion) {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: currentAccessKey.dataVersion,
                    currentData: currentAccessKey.data
                });
            }

            // Update with version check
            const { count } = await db.accessKey.updateMany({
                where: {
                    accountId: userId,
                    machineId,
                    sessionId,
                    dataVersion: expectedVersion
                },
                data: {
                    data,
                    dataVersion: expectedVersion + 1,
                    updatedAt: new Date()
                }
            });

            if (count === 0) {
                // Re-fetch to get current version
                const accessKey = await db.accessKey.findUnique({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: userId,
                            machineId,
                            sessionId
                        }
                    }
                });
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: accessKey?.dataVersion || 0,
                    currentData: accessKey?.data || ''
                });
            }

            log({ module: 'access-keys', userId, sessionId, machineId }, `Updated access key to version ${expectedVersion + 1}`);

            return reply.send({
                success: true,
                version: expectedVersion + 1
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update access key: ${error}`);
            return reply.code(500).send({
                success: false,
                error: 'Failed to update access key'
            });
        }
    });
}