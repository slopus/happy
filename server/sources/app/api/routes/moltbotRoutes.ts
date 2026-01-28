import { db } from "@/storage/db";
import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import * as privacyKit from "privacy-kit";
import { MoltbotMachine } from "@prisma/client";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import {
    eventRouter,
    buildNewMoltbotMachineUpdate,
    buildUpdateMoltbotMachineUpdate,
    buildDeleteMoltbotMachineUpdate
} from "@/app/events/eventRouter";

/**
 * Moltbot Machine Routes
 *
 * Provides CRUD operations for Moltbot machines. Moltbot machines can be of two types:
 * - 'happy': Relay through a Happy device (requires happyMachineId)
 * - 'direct': Direct WebSocket connection (requires directConfig)
 *
 * All sensitive fields (metadata, directConfig, pairingData) are encrypted on the client side
 * and stored as-is on the server. The dataEncryptionKey is stored for key management purposes.
 *
 * Optimistic concurrency control is supported via expectedMetadataVersion for updates.
 */

/**
 * Format Moltbot machine for API response
 */
function formatMoltbotMachine(m: MoltbotMachine) {
    return {
        id: m.id,
        type: m.type,
        happyMachineId: m.happyMachineId,
        directConfig: m.directConfig,
        metadata: m.metadata,
        metadataVersion: m.metadataVersion,
        pairingData: m.pairingData,
        dataEncryptionKey: m.dataEncryptionKey ? privacyKit.encodeBase64(m.dataEncryptionKey) : null,
        seq: m.seq,
        createdAt: m.createdAt.getTime(),
        updatedAt: m.updatedAt.getTime()
    };
}

export function moltbotRoutes(app: Fastify) {
    // GET /v1/moltbot/machines - List all Moltbot machines for the account
    app.get('/v1/moltbot/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const machines = await db.moltbotMachine.findMany({
                where: { accountId: userId },
                orderBy: { updatedAt: 'desc' }
            });

            return machines.map(formatMoltbotMachine);
        } catch (error) {
            log({ module: 'moltbot', level: 'error' }, `Failed to list Moltbot machines: ${error}`);
            return reply.code(500).send({ error: 'Failed to list machines' });
        }
    });

    // POST /v1/moltbot/machines - Create new Moltbot machine
    app.post('/v1/moltbot/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                type: z.enum(['happy', 'direct']),
                happyMachineId: z.string().optional(),
                directConfig: z.string().optional(),
                metadata: z.string(),
                pairingData: z.string().optional(),
                dataEncryptionKey: z.string().optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { type, happyMachineId, directConfig, metadata, pairingData, dataEncryptionKey } = request.body;

        // Validate type-specific requirements
        if (type === 'happy' && !happyMachineId) {
            return reply.code(400).send({ error: 'happyMachineId is required when type is happy' });
        }
        if (type === 'direct' && !directConfig) {
            return reply.code(400).send({ error: 'directConfig is required when type is direct' });
        }

        try {
            log({ module: 'moltbot', userId }, 'Creating new Moltbot machine');

            const machine = await db.moltbotMachine.create({
                data: {
                    accountId: userId,
                    type,
                    happyMachineId: type === 'happy' ? happyMachineId : null,
                    directConfig: type === 'direct' ? directConfig : null,
                    metadata,
                    metadataVersion: 1,
                    pairingData: pairingData || null,
                    dataEncryptionKey: dataEncryptionKey ? privacyKit.decodeBase64(dataEncryptionKey) : null,
                    seq: 0
                }
            });

            // Emit new-moltbot-machine event
            const updSeq = await allocateUserSeq(userId);
            const newMachinePayload = buildNewMoltbotMachineUpdate(machine, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: newMachinePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                machine: formatMoltbotMachine(machine)
            });
        } catch (error) {
            log({ module: 'moltbot', level: 'error' }, `Failed to create Moltbot machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to create machine' });
        }
    });

    // GET /v1/moltbot/machines/:id - Get single Moltbot machine by ID
    app.get('/v1/moltbot/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const machine = await db.moltbotMachine.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!machine) {
                return reply.code(404).send({ error: 'Moltbot machine not found' });
            }

            return {
                machine: formatMoltbotMachine(machine)
            };
        } catch (error) {
            log({ module: 'moltbot', level: 'error' }, `Failed to get Moltbot machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to get machine' });
        }
    });

    // PUT /v1/moltbot/machines/:id - Update Moltbot machine
    app.put('/v1/moltbot/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                metadata: z.string().optional(),
                expectedMetadataVersion: z.number().int().min(0).optional(),
                pairingData: z.string().optional(),
                directConfig: z.string().optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { metadata, expectedMetadataVersion, pairingData, directConfig } = request.body;

        try {
            // Get current machine for version check
            const currentMachine = await db.moltbotMachine.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!currentMachine) {
                return reply.code(404).send({ error: 'Moltbot machine not found' });
            }

            // Check metadata version mismatch (optimistic concurrency control)
            if (metadata !== undefined && expectedMetadataVersion !== undefined) {
                if (currentMachine.metadataVersion !== expectedMetadataVersion) {
                    return reply.code(409).send({
                        error: 'version-mismatch',
                        currentMetadataVersion: currentMachine.metadataVersion,
                        currentMetadata: currentMachine.metadata
                    });
                }
            }

            // Build update data
            const updateData: {
                metadata?: string;
                metadataVersion?: number;
                pairingData?: string;
                directConfig?: string;
                seq: number;
                updatedAt: Date;
            } = {
                seq: currentMachine.seq + 1,
                updatedAt: new Date()
            };

            if (metadata !== undefined && expectedMetadataVersion !== undefined) {
                updateData.metadata = metadata;
                updateData.metadataVersion = expectedMetadataVersion + 1;
            }

            if (pairingData !== undefined) {
                updateData.pairingData = pairingData;
            }

            if (directConfig !== undefined) {
                // Only allow directConfig update for 'direct' type machines
                if (currentMachine.type !== 'direct') {
                    return reply.code(400).send({ error: 'directConfig can only be updated for direct type machines' });
                }
                updateData.directConfig = directConfig;
            }

            // Update machine
            const updatedMachine = await db.moltbotMachine.update({
                where: { id },
                data: updateData
            });

            // Emit update-moltbot-machine event
            const updSeq = await allocateUserSeq(userId);
            const eventUpdates: {
                metadata?: { value: string; version: number };
                pairingData?: string | null;
                directConfig?: string | null;
            } = {};
            if (updateData.metadata !== undefined && updateData.metadataVersion !== undefined) {
                eventUpdates.metadata = { value: updateData.metadata, version: updateData.metadataVersion };
            }
            if (pairingData !== undefined) {
                eventUpdates.pairingData = pairingData;
            }
            if (directConfig !== undefined) {
                eventUpdates.directConfig = directConfig;
            }
            const updatePayload = buildUpdateMoltbotMachineUpdate(id, updSeq, randomKeyNaked(12), eventUpdates);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                machine: formatMoltbotMachine(updatedMachine)
            });
        } catch (error) {
            log({ module: 'moltbot', level: 'error' }, `Failed to update Moltbot machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to update machine' });
        }
    });

    // DELETE /v1/moltbot/machines/:id - Delete Moltbot machine
    app.delete('/v1/moltbot/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            // Check if machine exists and belongs to user
            const machine = await db.moltbotMachine.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!machine) {
                return reply.code(404).send({ error: 'Moltbot machine not found' });
            }

            log({ module: 'moltbot', userId, machineId: id }, 'Deleting Moltbot machine');

            // Delete machine
            await db.moltbotMachine.delete({
                where: { id }
            });

            // Emit delete-moltbot-machine event
            const updSeq = await allocateUserSeq(userId);
            const deletePayload = buildDeleteMoltbotMachineUpdate(id, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'moltbot', level: 'error' }, `Failed to delete Moltbot machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete machine' });
        }
    });
}
