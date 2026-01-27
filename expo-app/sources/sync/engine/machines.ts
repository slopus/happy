import type { Machine } from '../storageTypes';

type MachineEncryption = {
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptDaemonState: (version: number, value: string) => Promise<any>;
};

export async function buildUpdatedMachineFromSocketUpdate(params: {
    machineUpdate: any;
    updateSeq: number;
    updateCreatedAt: number;
    existingMachine: Machine | undefined;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
}): Promise<Machine | null> {
    const { machineUpdate, updateSeq, updateCreatedAt, existingMachine, getMachineEncryption } = params;

    const machineId = machineUpdate.machineId; // Changed from .id to .machineId

    // Create or update machine with all required fields
    const updatedMachine: Machine = {
        id: machineId,
        seq: updateSeq,
        createdAt: existingMachine?.createdAt ?? updateCreatedAt,
        updatedAt: updateCreatedAt,
        active: machineUpdate.active ?? true,
        activeAt: machineUpdate.activeAt ?? updateCreatedAt,
        metadata: existingMachine?.metadata ?? null,
        metadataVersion: existingMachine?.metadataVersion ?? 0,
        daemonState: existingMachine?.daemonState ?? null,
        daemonStateVersion: existingMachine?.daemonStateVersion ?? 0,
    };

    // Get machine-specific encryption (might not exist if machine wasn't initialized)
    const machineEncryption = getMachineEncryption(machineId);
    if (!machineEncryption) {
        console.error(`Machine encryption not found for ${machineId} - cannot decrypt updates`);
        return null;
    }

    // If metadata is provided, decrypt and update it
    const metadataUpdate = machineUpdate.metadata;
    if (metadataUpdate) {
        try {
            const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
            updatedMachine.metadata = metadata;
            updatedMachine.metadataVersion = metadataUpdate.version;
        } catch (error) {
            console.error(`Failed to decrypt machine metadata for ${machineId}:`, error);
        }
    }

    // If daemonState is provided, decrypt and update it
    const daemonStateUpdate = machineUpdate.daemonState;
    if (daemonStateUpdate) {
        try {
            const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
            updatedMachine.daemonState = daemonState;
            updatedMachine.daemonStateVersion = daemonStateUpdate.version;
        } catch (error) {
            console.error(`Failed to decrypt machine daemonState for ${machineId}:`, error);
        }
    }

    return updatedMachine;
}

