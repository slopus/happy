import { websocketEventsCounter } from "@/app/monitoring/metrics2";
import { buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import * as privacyKit from "privacy-kit";

export function artifactUpdateHandler(userId: string, socket: Socket) {
    // Read artifact with full body
    socket.on('artifact-read', async (data: {
        artifactId: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-read' });

            const { artifactId } = data;

            // Validate input
            if (!artifactId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // Fetch artifact
            const artifact = await db.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: userId
                }
            });

            if (!artifact) {
                if (callback) {
                    callback({ result: 'error', message: 'Artifact not found' });
                }
                return;
            }

            // Return artifact data
            callback({
                result: 'success',
                artifact: {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(artifact.body),
                    bodyVersion: artifact.bodyVersion,
                    seq: artifact.seq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in artifact-read: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Update artifact with optimistic concurrency control
    socket.on('artifact-update', async (data: {
        artifactId: string;
        header?: {
            data: string;
            expectedVersion: number;
        };
        body?: {
            data: string;
            expectedVersion: number;
        };
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-update' });

            const { artifactId, header, body } = data;

            // Validate input
            if (!artifactId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // At least one update must be provided
            if (!header && !body) {
                if (callback) {
                    callback({ result: 'error', message: 'No updates provided' });
                }
                return;
            }

            // Validate header structure if provided
            if (header && (typeof header.data !== 'string' || typeof header.expectedVersion !== 'number')) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid header parameters' });
                }
                return;
            }

            // Validate body structure if provided
            if (body && (typeof body.data !== 'string' || typeof body.expectedVersion !== 'number')) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid body parameters' });
                }
                return;
            }

            // Get current artifact
            const currentArtifact = await db.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: userId
                }
            });

            if (!currentArtifact) {
                if (callback) {
                    callback({ result: 'error', message: 'Artifact not found' });
                }
                return;
            }

            // Check for version mismatches
            const headerMismatch = header && currentArtifact.headerVersion !== header.expectedVersion;
            const bodyMismatch = body && currentArtifact.bodyVersion !== body.expectedVersion;

            if (headerMismatch || bodyMismatch) {
                const response: any = { result: 'version-mismatch' };
                
                if (headerMismatch) {
                    response.header = {
                        currentVersion: currentArtifact.headerVersion,
                        currentData: privacyKit.encodeBase64(currentArtifact.header)
                    };
                }
                
                if (bodyMismatch) {
                    response.body = {
                        currentVersion: currentArtifact.bodyVersion,
                        currentData: privacyKit.encodeBase64(currentArtifact.body)
                    };
                }
                
                callback(response);
                return;
            }

            // Build update data
            const updateData: any = {
                updatedAt: new Date(),
                seq: currentArtifact.seq + 1
            };

            let headerUpdate: { value: string; version: number } | undefined;
            let bodyUpdate: { value: string; version: number } | undefined;

            if (header) {
                updateData.header = privacyKit.decodeBase64(header.data);
                updateData.headerVersion = header.expectedVersion + 1;
                headerUpdate = {
                    value: header.data,
                    version: header.expectedVersion + 1
                };
            }

            if (body) {
                updateData.body = privacyKit.decodeBase64(body.data);
                updateData.bodyVersion = body.expectedVersion + 1;
                bodyUpdate = {
                    value: body.data,
                    version: body.expectedVersion + 1
                };
            }

            // Perform atomic update with version check
            const { count } = await db.artifact.updateMany({
                where: {
                    id: artifactId,
                    accountId: userId,
                    ...(header && { headerVersion: header.expectedVersion }),
                    ...(body && { bodyVersion: body.expectedVersion })
                },
                data: updateData
            });

            if (count === 0) {
                // Re-fetch current version
                const current = await db.artifact.findFirst({
                    where: {
                        id: artifactId,
                        accountId: userId
                    }
                });

                const response: any = { result: 'version-mismatch' };
                
                if (header && current) {
                    response.header = {
                        currentVersion: current.headerVersion,
                        currentData: privacyKit.encodeBase64(current.header)
                    };
                }
                
                if (body && current) {
                    response.body = {
                        currentVersion: current.bodyVersion,
                        currentData: privacyKit.encodeBase64(current.body)
                    };
                }
                
                callback(response);
                return;
            }

            // Emit update event
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildUpdateArtifactUpdate(artifactId, updSeq, randomKeyNaked(12), headerUpdate, bodyUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Send success response
            const response: any = { result: 'success' };
            
            if (headerUpdate) {
                response.header = {
                    version: headerUpdate.version,
                    data: header!.data
                };
            }
            
            if (bodyUpdate) {
                response.body = {
                    version: bodyUpdate.version,
                    data: body!.data
                };
            }
            
            callback(response);
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in artifact-update: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Create new artifact
    socket.on('artifact-create', async (data: {
        id: string;
        header: string;
        body: string;
        dataEncryptionKey: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-create' });

            const { id, header, body, dataEncryptionKey } = data;

            // Validate input
            if (!id || typeof header !== 'string' || typeof body !== 'string' || typeof dataEncryptionKey !== 'string') {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // Check if artifact already exists
            const existingArtifact = await db.artifact.findUnique({
                where: { id }
            });

            if (existingArtifact) {
                // If exists for another account, return error
                if (existingArtifact.accountId !== userId) {
                    if (callback) {
                        callback({ result: 'error', message: 'Artifact with this ID already exists for another account' });
                    }
                    return;
                }

                // If exists for same account, return existing (idempotent)
                callback({
                    result: 'success',
                    artifact: {
                        id: existingArtifact.id,
                        header: privacyKit.encodeBase64(existingArtifact.header),
                        headerVersion: existingArtifact.headerVersion,
                        body: privacyKit.encodeBase64(existingArtifact.body),
                        bodyVersion: existingArtifact.bodyVersion,
                        seq: existingArtifact.seq,
                        createdAt: existingArtifact.createdAt.getTime(),
                        updatedAt: existingArtifact.updatedAt.getTime()
                    }
                });
                return;
            }

            // Create new artifact
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

            // Return created artifact
            callback({
                result: 'success',
                artifact: {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(artifact.body),
                    bodyVersion: artifact.bodyVersion,
                    seq: artifact.seq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in artifact-create: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Delete artifact
    socket.on('artifact-delete', async (data: {
        artifactId: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-delete' });

            const { artifactId } = data;

            // Validate input
            if (!artifactId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }

            // Check if artifact exists and belongs to user
            const artifact = await db.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: userId
                }
            });

            if (!artifact) {
                if (callback) {
                    callback({ result: 'error', message: 'Artifact not found' });
                }
                return;
            }

            // Delete artifact
            await db.artifact.delete({
                where: { id: artifactId }
            });

            // Emit delete-artifact event
            const updSeq = await allocateUserSeq(userId);
            const deletePayload = buildDeleteArtifactUpdate(artifactId, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Send success response
            callback({ result: 'success' });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in artifact-delete: ${error}`);
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}