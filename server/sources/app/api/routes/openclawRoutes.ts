import { db } from "@/storage/db";
import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import * as privacyKit from "privacy-kit";
import { OpenClawMachine } from "@prisma/client";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import {
    eventRouter,
    buildNewOpenClawMachineUpdate,
    buildUpdateOpenClawMachineUpdate,
    buildDeleteOpenClawMachineUpdate
} from "@/app/events/eventRouter";

/**
 * OpenClaw Machine Routes
 *
 * Provides CRUD operations for OpenClaw machines. OpenClaw machines can be of two types:
 * - 'happy': Relay through a Happy device (requires happyMachineId)
 * - 'direct': Direct WebSocket connection (requires directConfig)
 *
 * All sensitive fields (metadata, directConfig, pairingData) are encrypted on the client side
 * and stored as-is on the server. The dataEncryptionKey is stored for key management purposes.
 *
 * Optimistic concurrency control is supported via expectedMetadataVersion for updates.
 */

/**
 * Format OpenClaw machine for API response
 */
function formatOpenClawMachine(m: OpenClawMachine) {
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

export function openclawRoutes(app: Fastify) {
    // GET /v1/openclaw/machines - List all OpenClaw machines for the account
    app.get('/v1/openclaw/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const machines = await db.openClawMachine.findMany({
                where: { accountId: userId },
                orderBy: { updatedAt: 'desc' }
            });

            return machines.map(formatOpenClawMachine);
        } catch (error) {
            log({ module: 'openclaw', level: 'error' }, `Failed to list OpenClaw machines: ${error}`);
            return reply.code(500).send({ error: 'Failed to list machines' });
        }
    });

    // POST /v1/openclaw/machines - Create new OpenClaw machine
    app.post('/v1/openclaw/machines', {
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
            log({ module: 'openclaw', userId }, 'Creating new OpenClaw machine');

            const machine = await db.openClawMachine.create({
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

            // Emit new-openclaw-machine event
            const updSeq = await allocateUserSeq(userId);
            const newMachinePayload = buildNewOpenClawMachineUpdate(machine, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: newMachinePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                machine: formatOpenClawMachine(machine)
            });
        } catch (error) {
            log({ module: 'openclaw', level: 'error' }, `Failed to create OpenClaw machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to create machine' });
        }
    });

    // GET /v1/openclaw/machines/:id - Get single OpenClaw machine by ID
    app.get('/v1/openclaw/machines/:id', {
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
            const machine = await db.openClawMachine.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!machine) {
                return reply.code(404).send({ error: 'OpenClaw machine not found' });
            }

            return {
                machine: formatOpenClawMachine(machine)
            };
        } catch (error) {
            log({ module: 'openclaw', level: 'error' }, `Failed to get OpenClaw machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to get machine' });
        }
    });

    // PUT /v1/openclaw/machines/:id - Update OpenClaw machine
    app.put('/v1/openclaw/machines/:id', {
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
            const currentMachine = await db.openClawMachine.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!currentMachine) {
                return reply.code(404).send({ error: 'OpenClaw machine not found' });
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
            const updatedMachine = await db.openClawMachine.update({
                where: { id },
                data: updateData
            });

            // Emit update-openclaw-machine event
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
            const updatePayload = buildUpdateOpenClawMachineUpdate(id, updSeq, randomKeyNaked(12), eventUpdates);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                machine: formatOpenClawMachine(updatedMachine)
            });
        } catch (error) {
            log({ module: 'openclaw', level: 'error' }, `Failed to update OpenClaw machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to update machine' });
        }
    });

    // DELETE /v1/openclaw/machines/:id - Delete OpenClaw machine
    app.delete('/v1/openclaw/machines/:id', {
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
            const machine = await db.openClawMachine.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!machine) {
                return reply.code(404).send({ error: 'OpenClaw machine not found' });
            }

            log({ module: 'openclaw', userId, machineId: id }, 'Deleting OpenClaw machine');

            // Delete machine
            await db.openClawMachine.delete({
                where: { id }
            });

            // Emit delete-openclaw-machine event
            const updSeq = await allocateUserSeq(userId);
            const deletePayload = buildDeleteOpenClawMachineUpdate(id, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'openclaw', level: 'error' }, `Failed to delete OpenClaw machine: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete machine' });
        }
    });
}
