import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { z } from "zod";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewMachineUpdate, buildUpdateMachineUpdate } from "@/app/events/eventRouter";

export function machinesRoutes(app: Fastify) {
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;

        // Check if machine exists (like sessions do)
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (machine) {
            // Machine exists - just return it
            log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
            return reply.send({
                machine: {
                    id: machine.id,
                    metadata: machine.metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState,
                    daemonStateVersion: machine.daemonStateVersion,
                    dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                    active: machine.active,
                    activeAt: machine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: machine.createdAt.getTime(),
                    updatedAt: machine.updatedAt.getTime()
                }
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            let newMachine;
            try {
                newMachine = await db.machine.create({
                    data: {
                        id,
                        accountId: userId,
                        metadata,
                        metadataVersion: 1,
                        daemonState: daemonState || null,
                        daemonStateVersion: daemonState ? 1 : 0,
                        dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                        // Default to offline - in case the user does not start daemon
                        active: false,
                        // lastActiveAt and activeAt defaults to now() in schema
                    }
                });
            } catch (e) {
                // Concurrency safety: multiple clients may race to create the same machine (e.g. daemon + session spawns).
                // If we lost the race, fetch the winner row and return it instead of surfacing a 500.
                if (isPrismaErrorCode(e, 'P2002')) {
                    const existing = await db.machine.findFirst({
                        where: { accountId: userId, id }
                    });
                    if (existing) {
                        log({ module: 'machines', machineId: id, userId }, 'Machine created concurrently; returning existing machine');
                        return reply.send({
                            machine: {
                                id: existing.id,
                                metadata: existing.metadata,
                                metadataVersion: existing.metadataVersion,
                                daemonState: existing.daemonState,
                                daemonStateVersion: existing.daemonStateVersion,
                                dataEncryptionKey: existing.dataEncryptionKey ? Buffer.from(existing.dataEncryptionKey).toString('base64') : null,
                                active: existing.active,
                                activeAt: existing.lastActiveAt.getTime(),
                                createdAt: existing.createdAt.getTime(),
                                updatedAt: existing.updatedAt.getTime()
                            }
                        });
                    }
                }
                throw e;
            }

            // Emit both new-machine and update-machine events for backward compatibility
            const updSeq1 = await allocateUserSeq(userId);
            const updSeq2 = await allocateUserSeq(userId);
            
            // Emit new-machine event with all data including dataEncryptionKey
            const newMachinePayload = buildNewMachineUpdate(newMachine, updSeq1, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: newMachinePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Emit update-machine event for backward compatibility (without dataEncryptionKey)
            const machineMetadata = {
                version: 1,
                value: metadata
            };
            const updatePayload = buildUpdateMachineUpdate(newMachine.id, updSeq2, randomKeyNaked(12), machineMetadata);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId: newMachine.id }
            });

            return reply.send({
                machine: {
                    id: newMachine.id,
                    metadata: newMachine.metadata,
                    metadataVersion: newMachine.metadataVersion,
                    daemonState: newMachine.daemonState,
                    daemonStateVersion: newMachine.daemonStateVersion,
                    dataEncryptionKey: newMachine.dataEncryptionKey ? Buffer.from(newMachine.dataEncryptionKey).toString('base64') : null,
                    active: newMachine.active,
                    activeAt: newMachine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: newMachine.createdAt.getTime(),
                    updatedAt: newMachine.updatedAt.getTime()
                }
            });
        }
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' }
        });

        return machines.map(m => ({
            id: m.id,
            metadata: m.metadata,
            metadataVersion: m.metadataVersion,
            daemonState: m.daemonState,
            daemonStateVersion: m.daemonStateVersion,
            dataEncryptionKey: m.dataEncryptionKey ? Buffer.from(m.dataEncryptionKey).toString('base64') : null,
            seq: m.seq,
            active: m.active,
            activeAt: m.lastActiveAt.getTime(),
            createdAt: m.createdAt.getTime(),
            updatedAt: m.updatedAt.getTime()
        }));
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                id: machine.id,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                seq: machine.seq,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        };
    });

}
