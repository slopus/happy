import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { inTx, afterTx } from "@/storage/inTx";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewMachineUpdate, buildUpdateMachineUpdate, buildDeleteMachineUpdate } from "@/app/events/eventRouter";
import { invalidateSessionFollowups } from "@/app/automation/sessionFollowupInvalidationService";
import { emitProjectAutomationUpdate } from "@/app/automation/automationUpdate";
import type { ManagedControlRuntime } from "@/app/managed/managedControlRuntime";
import { authorizeManagedDaemonRequest } from "@/app/managed/managedDaemonAccess";

const MACHINE_DATA_KEY_ENVELOPE_LENGTH = 105;
const MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH = 140;

function decodeMachineDataKeyEnvelope(value: string): Uint8Array | null {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value
        || decoded.length !== MACHINE_DATA_KEY_ENVELOPE_LENGTH
        || decoded[0] !== 0x00) {
        return null;
    }
    return new Uint8Array(decoded);
}

/** R21: 0x01 | attester public key (32) | nonce (24) | box (at least a statement and its tag). */
const MACHINE_KEY_ATTESTATION_MIN_BYTES = 1 + 32 + 24 + 16 + 40;
const MACHINE_KEY_ATTESTATION_MAX_BYTES = 1024;
const MACHINE_KEY_ATTESTATION_BASE64_MAX = Math.ceil(MACHINE_KEY_ATTESTATION_MAX_BYTES / 3) * 4;

function decodeMachineKeyAttestation(value: string): Buffer | null {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < MACHINE_KEY_ATTESTATION_MIN_BYTES || bytes.length > MACHINE_KEY_ATTESTATION_MAX_BYTES || bytes[0] !== 1) return null;
    return bytes;
}

function machineDataKeyEnvelopesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return Buffer.from(left).equals(Buffer.from(right));
}

export function machinesRoutes(
    app: Fastify,
    getManagedControl: () => ManagedControlRuntime | null = () => null,
) {
    /**
     * `GET /v1/machines/:id` is the one HTTP read a managed daemon makes about
     * itself, at start (`attachRegisteredMachine`). Its credential is not an
     * account bearer — the daemon never holds one, by design — so `authenticate`
     * alone refused every managed runtime at boot.
     *
     * The daemon's credential is tried first, and only as a credential for
     * **this** machine: `authorizeManagedDaemonRequest` verifies the signature
     * against the issuer this server holds and the grant row it was issued
     * from, and refuses a token that names any other machine. What it yields
     * is the account the machine belongs to, which is what the handler's
     * `accountId` lookup needs. Anything else falls through to the account
     * path unchanged, so the refusal and its log line stay where they were.
     */
    const authenticateMachineRead = async (request: any, reply: any) => {
        const header = request.headers.authorization;
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.substring(7) : null;
        const runtime = getManagedControl();
        if (token && runtime) {
            let result: Awaited<ReturnType<typeof authorizeManagedDaemonRequest>> | null = null;
            try {
                result = await authorizeManagedDaemonRequest({
                    token,
                    issuer: runtime.daemonTokens,
                    machineId: String(request.params?.id ?? ''),
                    now: Date.now(),
                });
            } catch {
                result = null;
            }
            if (result?.ok) {
                request.userId = result.principal.claims.accountId;
                return;
            }
        }
        return app.authenticate(request, reply);
    };

    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish(),
                // aplus §6-1 B1 — machineKey 의 서버 몫 봉투 (이중 수신자 wrap)
                serverDataEncryptionKey: z.string().nullish(),
                // specs/e2ee-machine-control-boundary R1 — the server's own RPC key
                serverRpcKeyEnvelope: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey, serverDataEncryptionKey, serverRpcKeyEnvelope } = request.body;
        // Unlike the two older envelopes this one has no legacy writers, so its
        // format is checked before anything is stored.
        const submittedServerRpcKey = serverRpcKeyEnvelope ? decodeMachineDataKeyEnvelope(serverRpcKeyEnvelope) : null;
        if (serverRpcKeyEnvelope && !submittedServerRpcKey) {
            return reply.code(400).send({ error: 'invalid-server-rpc-key-envelope' });
        }

        // Check if machine exists (like sessions do)
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (machine) {
            // Machine exists - return it, backfilling dataEncryptionKey once
            // if it was registered without one (legacy-mode CLI) and the
            // daemon now submits a wrapped key. Write-once: an existing
            // non-null key is NEVER overwritten here — replacing it would
            // orphan ciphertext and allow key-swap; rotation must be an
            // explicit separate flow. (aplus §6-1 machine key provisioning)
            let effectiveDataEncryptionKey = machine.dataEncryptionKey;
            if (!machine.dataEncryptionKey && dataEncryptionKey) {
                const submitted = new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'));
                await db.machine.update({
                    where: { id: machine.id },
                    data: { dataEncryptionKey: submitted }
                });
                effectiveDataEncryptionKey = submitted;
                log({ module: 'machines', machineId: id, userId }, 'Backfilled dataEncryptionKey for existing machine');
            }
            // Same write-once rule for the server-recipient envelope — the two
            // envelopes backfill independently (an account-wrapped key may land
            // releases earlier than the server-wrapped one).
            let effectiveServerDataEncryptionKey = machine.serverDataEncryptionKey;
            if (!machine.serverDataEncryptionKey && serverDataEncryptionKey) {
                const submitted = new Uint8Array(Buffer.from(serverDataEncryptionKey, 'base64'));
                await db.machine.update({
                    where: { id: machine.id },
                    data: { serverDataEncryptionKey: submitted }
                });
                effectiveServerDataEncryptionKey = submitted;
                log({ module: 'machines', machineId: id, userId }, 'Backfilled serverDataEncryptionKey for existing machine');
            }
            let effectiveServerRpcKeyEnvelope = machine.serverRpcKeyEnvelope;
            if (!machine.serverRpcKeyEnvelope && submittedServerRpcKey) {
                const submitted = new Uint8Array(submittedServerRpcKey);
                await db.machine.update({
                    where: { id: machine.id },
                    data: { serverRpcKeyEnvelope: submitted }
                });
                effectiveServerRpcKeyEnvelope = submitted;
                log({ module: 'machines', machineId: id, userId }, 'Backfilled serverRpcKeyEnvelope for existing machine');
            }
            log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
            return reply.send({
                machine: {
                    id: machine.id,
                    accountId: machine.accountId,
                    metadata: machine.metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState,
                    daemonStateVersion: machine.daemonStateVersion,
                    dataEncryptionKey: effectiveDataEncryptionKey ? Buffer.from(effectiveDataEncryptionKey).toString('base64') : null,
                    serverDataEncryptionKey: effectiveServerDataEncryptionKey ? Buffer.from(effectiveServerDataEncryptionKey).toString('base64') : null,
                    serverRpcKeyEnvelope: effectiveServerRpcKeyEnvelope ? Buffer.from(effectiveServerRpcKeyEnvelope).toString('base64') : null,
                    dataKeyAttestation: machine.dataKeyAttestation ? Buffer.from(machine.dataKeyAttestation).toString('base64') : null,
                    active: machine.active,
                    activeAt: machine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: machine.createdAt.getTime(),
                    updatedAt: machine.updatedAt.getTime()
                }
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            const newMachine = await db.machine.create({
                data: {
                    id,
                    accountId: userId,
                    metadata,
                    metadataVersion: 1,
                    daemonState: daemonState || null,
                    daemonStateVersion: daemonState ? 1 : 0,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                    serverDataEncryptionKey: serverDataEncryptionKey ? new Uint8Array(Buffer.from(serverDataEncryptionKey, 'base64')) : undefined,
                    serverRpcKeyEnvelope: submittedServerRpcKey ? new Uint8Array(submittedServerRpcKey) : undefined,
                    // Default to offline - in case the user does not start daemon
                    active: false,
                    // lastActiveAt and activeAt defaults to now() in schema
                }
            });

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
                    accountId: newMachine.accountId,
                    metadata: newMachine.metadata,
                    metadataVersion: newMachine.metadataVersion,
                    daemonState: newMachine.daemonState,
                    daemonStateVersion: newMachine.daemonStateVersion,
                    dataEncryptionKey: newMachine.dataEncryptionKey ? Buffer.from(newMachine.dataEncryptionKey).toString('base64') : null,
                    serverDataEncryptionKey: newMachine.serverDataEncryptionKey ? Buffer.from(newMachine.serverDataEncryptionKey).toString('base64') : null,
                    serverRpcKeyEnvelope: newMachine.serverRpcKeyEnvelope ? Buffer.from(newMachine.serverRpcKeyEnvelope).toString('base64') : null,
                    dataKeyAttestation: null,
                    active: newMachine.active,
                    activeAt: newMachine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: newMachine.createdAt.getTime(),
                    updatedAt: newMachine.updatedAt.getTime()
                }
            });
        }
    });

    app.patch('/v1/machines/:id/data-encryption-key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                expectedDataEncryptionKey: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH),
                replacementDataEncryptionKey: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { expectedDataEncryptionKey, replacementDataEncryptionKey } = request.body;
        const expected = decodeMachineDataKeyEnvelope(expectedDataEncryptionKey);
        const replacement = decodeMachineDataKeyEnvelope(replacementDataEncryptionKey);
        if (!expected || !replacement) {
            return reply.code(400).send({ error: 'invalid-data-encryption-key-envelope' });
        }
        if (!machineDataKeyEnvelopesEqual(expected, replacement)) {
            const updated = await db.machine.updateMany({
                where: {
                    id,
                    accountId: userId,
                    dataEncryptionKey: new Uint8Array(expected)
                },
                data: {
                    dataEncryptionKey: new Uint8Array(replacement)
                }
            });
            if (updated.count > 0) {
                return reply.send({ ok: true, changed: true });
            }
        }

        const machine = await db.machine.findFirst({
            where: { id, accountId: userId },
            select: { dataEncryptionKey: true }
        });
        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }
        if (machine.dataEncryptionKey
            && machineDataKeyEnvelopesEqual(machine.dataEncryptionKey, replacement)) {
            return reply.send({ ok: true, changed: false });
        }
        return reply.code(409).send({ error: 'data-encryption-key-conflict' });
    });


    /**
     * specs/e2ee-machine-control-boundary R21 — a customer client stores its
     * attestation of the machine key, after a person compared fingerprints.
     * The server cannot make or check one (it is a box from the customer key
     * to itself); it checks the shape and stores it only while the machine
     * still has the account envelope the client attested, so an attestation
     * of a key rotated away in the meantime is refused. Null clears it.
     */
    app.put('/v1/machines/:id/data-key-attestation', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                expectedDataEncryptionKey: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH),
                attestation: z.string().max(MACHINE_KEY_ATTESTATION_BASE64_MAX).nullable(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const expected = decodeMachineDataKeyEnvelope(request.body.expectedDataEncryptionKey);
        const attestation = request.body.attestation === null ? null : decodeMachineKeyAttestation(request.body.attestation);
        if (!expected || (request.body.attestation !== null && !attestation)) {
            return reply.code(400).send({ error: 'invalid-data-key-attestation' });
        }
        const updated = await db.machine.updateMany({
            where: { id, accountId: userId, dataEncryptionKey: new Uint8Array(expected) },
            data: { dataKeyAttestation: attestation ? new Uint8Array(attestation) : null },
        });
        if (updated.count > 0) return reply.send({ ok: true });
        const machine = await db.machine.findFirst({ where: { id, accountId: userId }, select: { id: true } });
        if (!machine) return reply.code(404).send({ error: 'Machine not found' });
        return reply.code(409).send({ error: 'data-encryption-key-conflict' });
    });

    /**
     * specs/e2ee-machine-control-boundary R4 — a daemon switching to strict
     * mode takes its machine key back from the server. It generates a new
     * machine key and server RPC key and sends, in one compare-and-swap:
     * the new account envelope, the new server-lane envelope (or none), and
     * its metadata and daemon state re-encrypted under the new machine key.
     * The machine key's server envelope is cleared in the same write.
     *
     * The swap only applies while the account envelope and metadata version
     * are the ones the daemon read, so a concurrent reseed or metadata write
     * makes it fail instead of mixing keys. Repeating a rotation that already
     * landed is a success, so a daemon that lost the reply can retry.
     */
    app.post('/v1/machines/:id/key-rotation', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                expectedDataEncryptionKey: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH),
                dataEncryptionKey: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH),
                serverRpcKeyEnvelope: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH).nullable(),
                metadata: z.string(),
                expectedMetadataVersion: z.number().int().min(0),
                daemonState: z.string().nullable(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const body = request.body;
        const expected = decodeMachineDataKeyEnvelope(body.expectedDataEncryptionKey);
        const replacement = decodeMachineDataKeyEnvelope(body.dataEncryptionKey);
        const serverLane = body.serverRpcKeyEnvelope === null ? null : decodeMachineDataKeyEnvelope(body.serverRpcKeyEnvelope);
        if (!expected || !replacement || (body.serverRpcKeyEnvelope !== null && !serverLane)) {
            return reply.code(400).send({ error: 'invalid-data-encryption-key-envelope' });
        }

        const machine = await db.machine.findFirst({ where: { id, accountId: userId } });
        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        const sameEnvelope = (stored: Uint8Array | null, wanted: Uint8Array | null) => stored === null || wanted === null
            ? stored === wanted
            : machineDataKeyEnvelopesEqual(stored, wanted);
        const alreadyRotated = !!machine.dataEncryptionKey
            && machineDataKeyEnvelopesEqual(machine.dataEncryptionKey, replacement)
            && machine.serverDataEncryptionKey === null
            && sameEnvelope(machine.serverRpcKeyEnvelope, serverLane);
        if (alreadyRotated) {
            return reply.send({ ok: true, changed: false, metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion });
        }

        const metadataVersion = body.expectedMetadataVersion + 1;
        const daemonStateVersion = machine.daemonStateVersion + 1;
        const updated = await db.machine.updateMany({
            where: {
                id,
                accountId: userId,
                dataEncryptionKey: new Uint8Array(expected),
                metadataVersion: body.expectedMetadataVersion,
                daemonStateVersion: machine.daemonStateVersion,
            },
            data: {
                dataEncryptionKey: new Uint8Array(replacement),
                serverRpcKeyEnvelope: serverLane ? new Uint8Array(serverLane) : null,
                // The attestation vouched for the old machine key (R21).
                dataKeyAttestation: null,
                serverDataEncryptionKey: null,
                metadata: body.metadata,
                metadataVersion,
                daemonState: body.daemonState,
                daemonStateVersion,
            }
        });
        if (updated.count === 0) {
            return reply.code(409).send({ error: 'key-rotation-conflict' });
        }

        log({ module: 'machines', machineId: id, userId }, `Rotated machine key (server lane: ${serverLane ? 'yes' : 'none'})`);
        const updSeq = await allocateUserSeq(userId);
        const payload = buildUpdateMachineUpdate(id, updSeq, randomKeyNaked(12),
            { value: body.metadata, version: metadataVersion },
            body.daemonState === null ? undefined : { value: body.daemonState, version: daemonStateVersion });
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });
        eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'machine-scoped-only', machineId: id } });
        return reply.send({ ok: true, changed: true, metadataVersion, daemonStateVersion });
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
            // specs/cross-identity-machine-socket/ Phase 1 — web-ui needs
            // the machine owner accountId so it can pick the right Happy
            // identity (boost socket) when the active context differs.
            accountId: m.accountId,
            metadata: m.metadata,
            metadataVersion: m.metadataVersion,
            daemonState: m.daemonState,
            daemonStateVersion: m.daemonStateVersion,
            dataEncryptionKey: m.dataEncryptionKey ? Buffer.from(m.dataEncryptionKey).toString('base64') : null,
            serverDataEncryptionKey: m.serverDataEncryptionKey ? Buffer.from(m.serverDataEncryptionKey).toString('base64') : null,
            serverRpcKeyEnvelope: m.serverRpcKeyEnvelope ? Buffer.from(m.serverRpcKeyEnvelope).toString('base64') : null,
            dataKeyAttestation: m.dataKeyAttestation ? Buffer.from(m.dataKeyAttestation).toString('base64') : null,
            seq: m.seq,
            active: m.active,
            activeAt: m.lastActiveAt.getTime(),
            createdAt: m.createdAt.getTime(),
            updatedAt: m.updatedAt.getTime()
        }));
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: authenticateMachineRead,
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
                accountId: machine.accountId,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                serverDataEncryptionKey: machine.serverDataEncryptionKey ? Buffer.from(machine.serverDataEncryptionKey).toString('base64') : null,
                serverRpcKeyEnvelope: machine.serverRpcKeyEnvelope ? Buffer.from(machine.serverRpcKeyEnvelope).toString('base64') : null,
                dataKeyAttestation: machine.dataKeyAttestation ? Buffer.from(machine.dataKeyAttestation).toString('base64') : null,
                seq: machine.seq,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        };
    });

    // DELETE /v1/machines/:id - Remove a machine and its access keys.
    // Sessions spawned by this machine are preserved so history is not lost.
    app.delete('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const deleted = await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: { accountId: userId, id }
            });
            if (!machine) {
                return false;
            }

            // Session follow-ups deliberately retain historical machine IDs
            // instead of holding a foreign key. Fence active work before the
            // machine disappears so deleting and later re-registering the same
            // ID can never revive an old follow-up generation.
            const invalidatedFollowups = await invalidateSessionFollowups(
                tx,
                { machineAccountId: userId, machineId: id },
                'TARGET_MISMATCH',
            );
            const invalidatedProjectIds = [...new Set(
                invalidatedFollowups.map((followup) => followup.projectId as string),
            )];

            await tx.accessKey.deleteMany({
                where: { accountId: userId, machineId: id }
            });

            await tx.machine.delete({
                where: { id }
            });

            afterTx(tx, async () => {
                const updSeq = await allocateUserSeq(userId);
                const updatePayload = buildDeleteMachineUpdate(id, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
                log({ module: 'machines', machineId: id, userId }, 'Machine deleted');
                await Promise.all(invalidatedProjectIds.map((projectId) =>
                    emitProjectAutomationUpdate(projectId, { projectId, reason: 'sync' }, userId),
                ));
            });

            return true;
        });

        if (!deleted) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return reply.send({ success: true });
    });

}
