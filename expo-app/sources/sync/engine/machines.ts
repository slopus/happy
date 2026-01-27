import type { AuthCredentials } from '@/auth/tokenStorage';
import { log } from '@/log';
import { getServerUrl } from '../serverConfig';
import type { Machine } from '../storageTypes';

type MachineEncryption = {
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptDaemonState: (version: number, value: string) => Promise<any>;
};

type SyncEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeMachines: (machineKeysMap: Map<string, Uint8Array | null>) => Promise<void>;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
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

export function buildMachineFromMachineActivityEphemeralUpdate(params: {
    machine: Machine;
    updateData: { active: boolean; activeAt: number };
}): Machine {
    const { machine, updateData } = params;
    return {
        ...machine,
        active: updateData.active,
        activeAt: updateData.activeAt,
    };
}

export async function fetchAndApplyMachines(params: {
    credentials: AuthCredentials;
    encryption: SyncEncryption;
    machineDataKeys: Map<string, Uint8Array>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
}): Promise<void> {
    const { credentials, encryption, machineDataKeys, applyMachines } = params;

    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v1/machines`, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        console.error(`Failed to fetch machines: ${response.status}`);
        return;
    }

    const data = await response.json();
    const machines = data as Array<{
        id: string;
        metadata: string;
        metadataVersion: number;
        daemonState?: string | null;
        daemonStateVersion?: number;
        dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
        seq: number;
        active: boolean;
        activeAt: number; // Changed from lastActiveAt
        createdAt: number;
        updatedAt: number;
    }>;

    // First, collect and decrypt encryption keys for all machines
    const machineKeysMap = new Map<string, Uint8Array | null>();
    for (const machine of machines) {
        if (machine.dataEncryptionKey) {
            const decryptedKey = await encryption.decryptEncryptionKey(machine.dataEncryptionKey);
            if (!decryptedKey) {
                console.error(`Failed to decrypt data encryption key for machine ${machine.id}`);
                continue;
            }
            machineKeysMap.set(machine.id, decryptedKey);
            machineDataKeys.set(machine.id, decryptedKey);
        } else {
            machineKeysMap.set(machine.id, null);
        }
    }

    // Initialize machine encryptions
    await encryption.initializeMachines(machineKeysMap);

    // Process all machines first, then update state once
    const decryptedMachines: Machine[] = [];

    for (const machine of machines) {
        // Get machine-specific encryption (might exist from previous initialization)
        const machineEncryption = encryption.getMachineEncryption(machine.id);
        if (!machineEncryption) {
            console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
            continue;
        }

        try {
            // Use machine-specific encryption (which handles fallback internally)
            const metadata = machine.metadata
                ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                : null;

            const daemonState = machine.daemonState
                ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                : null;

            decryptedMachines.push({
                id: machine.id,
                seq: machine.seq,
                createdAt: machine.createdAt,
                updatedAt: machine.updatedAt,
                active: machine.active,
                activeAt: machine.activeAt,
                metadata,
                metadataVersion: machine.metadataVersion,
                daemonState,
                daemonStateVersion: machine.daemonStateVersion || 0,
            });
        } catch (error) {
            console.error(`Failed to decrypt machine ${machine.id}:`, error);
            // Still add the machine with null metadata
            decryptedMachines.push({
                id: machine.id,
                seq: machine.seq,
                createdAt: machine.createdAt,
                updatedAt: machine.updatedAt,
                active: machine.active,
                activeAt: machine.activeAt,
                metadata: null,
                metadataVersion: machine.metadataVersion,
                daemonState: null,
                daemonStateVersion: 0,
            });
        }
    }

    // Replace entire machine state with fetched machines
    applyMachines(decryptedMachines, true);
    log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
}
