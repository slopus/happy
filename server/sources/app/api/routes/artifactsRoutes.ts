import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import * as privacyKit from "privacy-kit";

export function artifactsRoutes(app: Fastify) {
    // GET /v1/artifacts - List all artifacts for the account
    app.get('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.array(z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                })),
                500: z.object({
                    error: z.literal('Failed to get artifacts')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const artifacts = await db.artifact.findMany({
                where: { accountId: userId },
                orderBy: { updatedAt: 'desc' },
                select: {
                    id: true,
                    header: true,
                    headerVersion: true,
                    dataEncryptionKey: true,
                    seq: true,
                    createdAt: true,
                    updatedAt: true
                }
            });

            return reply.send(artifacts.map(a => ({
                id: a.id,
                header: privacyKit.encodeBase64(a.header),
                headerVersion: a.headerVersion,
                dataEncryptionKey: privacyKit.encodeBase64(a.dataEncryptionKey),
                seq: a.seq,
                createdAt: a.createdAt.getTime(),
                updatedAt: a.updatedAt.getTime()
            })));
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get artifacts: ${error}`);
            return reply.code(500).send({ error: 'Failed to get artifacts' });
        }
    });

    // GET /v1/artifacts/:id - Get single artifact with full body
    app.get('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const artifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to get artifact' });
        }
    });

    // POST /v1/artifacts - Create new artifact
    app.post('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().uuid(),
                header: z.string(),
                body: z.string(),
                dataEncryptionKey: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                409: z.object({
                    error: z.literal('Artifact with this ID already exists for another account')
                }),
                500: z.object({
                    error: z.literal('Failed to create artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, header, body, dataEncryptionKey } = request.body;

        try {
            // Check if artifact exists
            const existingArtifact = await db.artifact.findUnique({
                where: { id }
            });

            if (existingArtifact) {
                // If exists for another account, return conflict
                if (existingArtifact.accountId !== userId) {
                    return reply.code(409).send({ 
                        error: 'Artifact with this ID already exists for another account' 
                    });
                }
                
                // If exists for same account, return existing (idempotent)
                log({ module: 'api', artifactId: id, userId }, 'Found existing artifact');
                return reply.send({
                    id: existingArtifact.id,
                    header: privacyKit.encodeBase64(existingArtifact.header),
                    headerVersion: existingArtifact.headerVersion,
                    body: privacyKit.encodeBase64(existingArtifact.body),
                    bodyVersion: existingArtifact.bodyVersion,
                    dataEncryptionKey: privacyKit.encodeBase64(existingArtifact.dataEncryptionKey),
                    seq: existingArtifact.seq,
                    createdAt: existingArtifact.createdAt.getTime(),
                    updatedAt: existingArtifact.updatedAt.getTime()
                });
            }

            // Create new artifact
            log({ module: 'api', artifactId: id, userId }, 'Creating new artifact');
            const artifact = await db.artifact.create({
                data: {
                    id,
                    accountId: userId,
                    header: privacyKit.decodeBase64(header),
                    headerVersion: 1,
                    body: privacyKit.decodeBase64(body),
                    bodyVersion: 1,
                    dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
                    seq: 0
                }
            });

            // Emit new-artifact event
            const updSeq = await allocateUserSeq(userId);
            const newArtifactPayload = buildNewArtifactUpdate(artifact, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: newArtifactPayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to create artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to create artifact' });
        }
    });

    // POST /v1/artifacts/:id - Update artifact with version control
    app.post('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                header: z.string().optional(),
                expectedHeaderVersion: z.number().int().min(0).optional(),
                body: z.string().optional(),
                expectedBodyVersion: z.number().int().min(0).optional()
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        headerVersion: z.number().optional(),
                        bodyVersion: z.number().optional()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentHeaderVersion: z.number().optional(),
                        currentBodyVersion: z.number().optional(),
                        currentHeader: z.string().optional(),
                        currentBody: z.string().optional()
                    })
                ]),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to update artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { header, expectedHeaderVersion, body, expectedBodyVersion } = request.body;

        try {
            // Get current artifact for version check
            const currentArtifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!currentArtifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            // Check version mismatches
            const headerMismatch = header !== undefined && expectedHeaderVersion !== undefined && 
                                   currentArtifact.headerVersion !== expectedHeaderVersion;
            const bodyMismatch = body !== undefined && expectedBodyVersion !== undefined && 
                                 currentArtifact.bodyVersion !== expectedBodyVersion;

            if (headerMismatch || bodyMismatch) {
                return reply.send({
                    success: false,
                    error: 'version-mismatch',
                    ...(headerMismatch && {
                        currentHeaderVersion: currentArtifact.headerVersion,
                        currentHeader: privacyKit.encodeBase64(currentArtifact.header)
                    }),
                    ...(bodyMismatch && {
                        currentBodyVersion: currentArtifact.bodyVersion,
                        currentBody: privacyKit.encodeBase64(currentArtifact.body)
                    })
                });
            }

            // Build update data
            const updateData: any = {
                updatedAt: new Date()
            };
            
            let headerUpdate: { value: string; version: number } | undefined;
            let bodyUpdate: { value: string; version: number } | undefined;

            if (header !== undefined && expectedHeaderVersion !== undefined) {
                updateData.header = privacyKit.decodeBase64(header);
                updateData.headerVersion = expectedHeaderVersion + 1;
                headerUpdate = {
                    value: header,
                    version: expectedHeaderVersion + 1
                };
            }

            if (body !== undefined && expectedBodyVersion !== undefined) {
                updateData.body = privacyKit.decodeBase64(body);
                updateData.bodyVersion = expectedBodyVersion + 1;
                bodyUpdate = {
                    value: body,
                    version: expectedBodyVersion + 1
                };
            }

            // Increment seq
            updateData.seq = currentArtifact.seq + 1;

            // Update artifact
            await db.artifact.update({
                where: { id },
                data: updateData
            });

            // Emit update-artifact event
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildUpdateArtifactUpdate(id, updSeq, randomKeyNaked(12), headerUpdate, bodyUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                ...(headerUpdate && { headerVersion: headerUpdate.version }),
                ...(bodyUpdate && { bodyVersion: bodyUpdate.version })
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to update artifact' });
        }
    });

    // DELETE /v1/artifacts/:id - Delete artifact
    app.delete('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to delete artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            // Check if artifact exists and belongs to user
            const artifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            // Delete artifact
            await db.artifact.delete({
                where: { id }
            });

            // Emit delete-artifact event
            const updSeq = await allocateUserSeq(userId);
            const deletePayload = buildDeleteArtifactUpdate(id, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to delete artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete artifact' });
        }
    });
}