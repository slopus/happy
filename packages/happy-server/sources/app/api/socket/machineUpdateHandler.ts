import { machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildMachineActivityEphemeral, buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

export function machineUpdateHandler(userId: string, socket: Socket) {
    socket.on('machine-alive', async (data: {
        machineId: string;
        time: number;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive' });
            machineAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.machineId) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            // Check machine validity using cache
            const isValid = await activityCache.isMachineValid(data.machineId, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueMachineUpdate(data.machineId, t);

            const machineActivity = buildMachineActivityEphemeral(data.machineId, true, t);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-alive: ${error}`);
        }
    });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { machineId, metadata, expectedVersion } = data;

            // Validate input
            if (!machineId || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // Resolve machine
            const machine = await db.machine.findFirst({
                where: {
                    accountId: userId,
                    id: machineId
                }
            });
            if (!machine) {
                if (callback) {
                    callback({ result: 'error', message: 'Machine not found' });
                }
                return;
            }

            // Check version
            if (machine.metadataVersion !== expectedVersion) {
                callback({
                    result: 'version-mismatch',
                    version: machine.metadataVersion,
                    metadata: machine.metadata
                });
                return;
            }

            // Update metadata with atomic version check
            const { count } = await db.machine.updateMany({
                where: {
                    accountId: userId,
                    id: machineId,
                    metadataVersion: expectedVersion  // Atomic CAS
                },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                    // NOT updating active or lastActiveAt here
                }
            });

            if (count === 0) {
                // Re-fetch current version
                const current = await db.machine.findFirst({
                    where: {
                        accountId: userId,
                        id: machineId
                    }
                });
                callback({
                    result: 'version-mismatch',
                    version: current?.metadataVersion || 0,
                    metadata: current?.metadata
                });
                return;
            }

            // Generate machine metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId }
            });

            // Send success response with new version
            callback({
                result: 'success',
                version: expectedVersion + 1,
                metadata: metadata
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Machine daemon state update with optimistic concurrency control
    socket.on('machine-update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { machineId, daemonState, expectedVersion } = data;

            // Validate input
            if (!machineId || typeof daemonState !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // Resolve machine
            const machine = await db.machine.findFirst({
                where: {
                    accountId: userId,
                    id: machineId
                }
            });
            if (!machine) {
                if (callback) {
                    callback({ result: 'error', message: 'Machine not found' });
                }
                return;
            }

            // Check version
            if (machine.daemonStateVersion !== expectedVersion) {
                callback({
                    result: 'version-mismatch',
                    version: machine.daemonStateVersion,
                    daemonState: machine.daemonState
                });
                return;
            }

            // Update daemon state with atomic version check
            const { count } = await db.machine.updateMany({
                where: {
                    accountId: userId,
                    id: machineId,
                    daemonStateVersion: expectedVersion  // Atomic CAS
                },
                data: {
                    daemonState: daemonState,
                    daemonStateVersion: expectedVersion + 1,
                    active: true,
                    lastActiveAt: new Date()
                }
            });

            if (count === 0) {
                // Re-fetch current version
                const current = await db.machine.findFirst({
                    where: {
                        accountId: userId,
                        id: machineId
                    }
                });
                callback({
                    result: 'version-mismatch',
                    version: current?.daemonStateVersion || 0,
                    daemonState: current?.daemonState
                });
                return;
            }

            // Generate machine daemon state update
            const updSeq = await allocateUserSeq(userId);
            const daemonStateUpdate = {
                value: daemonState,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), undefined, daemonStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId }
            });

            // Send success response with new version
            callback({
                result: 'success',
                version: expectedVersion + 1,
                daemonState: daemonState
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in machine-update-state: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}