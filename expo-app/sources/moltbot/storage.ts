/**
 * Moltbot Storage
 *
 * Storage and sync for Moltbot machines, integrating with the main
 * Zustand store and sync system.
 */

import { getServerUrl } from '../sync/serverConfig';
import {
    MoltbotMetadataSchema,
    MoltbotPairingDataSchema,
    MoltbotDirectConfigSchema,
} from './types';
import type {
    MoltbotMachine,
    MoltbotMetadata,
    MoltbotPairingData,
    MoltbotDirectConfig,
} from './types';

// Re-export types for convenience
export type {
    MoltbotMachine,
    MoltbotMetadata,
    MoltbotPairingData,
    MoltbotDirectConfig,
};

/**
 * Raw Moltbot machine data from server API
 */
export interface RawMoltbotMachine {
    id: string;
    type: string;
    happyMachineId: string | null;
    directConfig: string | null;  // Encrypted
    metadata: string;             // Encrypted
    metadataVersion: number;
    pairingData: string | null;   // Encrypted
    dataEncryptionKey: string | null;
    seq: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Credentials for API calls
 */
interface Credentials {
    token: string;
}

/**
 * Encryption interface (subset of what we need from sync encryption)
 */
interface MoltbotEncryption {
    decryptWithKey(encryptedData: string, key: Uint8Array): Promise<unknown>;
    encryptWithKey(data: unknown, key: Uint8Array): Promise<string>;
    decryptEncryptionKey(encryptedKey: string): Promise<Uint8Array | null>;
    generateDataKey(): Promise<{ key: Uint8Array; encryptedKey: string }>;
}

/**
 * Fetch all Moltbot machines from server
 */
export async function fetchMoltbotMachines(
    credentials: Credentials,
    encryption: MoltbotEncryption
): Promise<MoltbotMachine[]> {
    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v1/moltbot/machines`, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        console.error(`Failed to fetch Moltbot machines: ${response.status}`);
        return [];
    }

    const rawMachines = await response.json() as RawMoltbotMachine[];
    console.log(`🤖 Moltbot: Fetched ${rawMachines.length} machines from server`);

    const decryptedMachines: MoltbotMachine[] = [];

    for (const raw of rawMachines) {
        try {
            const machine = await decryptMoltbotMachine(raw, encryption);
            if (machine) {
                decryptedMachines.push(machine);
            }
        } catch (error) {
            console.error(`Failed to decrypt Moltbot machine ${raw.id}:`, error);
        }
    }

    return decryptedMachines;
}

/**
 * Create a new Moltbot machine
 */
export async function createMoltbotMachine(
    credentials: Credentials,
    encryption: MoltbotEncryption,
    params: {
        type: 'happy' | 'direct';
        happyMachineId?: string;
        directConfig?: MoltbotDirectConfig;
        metadata: MoltbotMetadata;
        pairingData?: MoltbotPairingData;
    }
): Promise<MoltbotMachine | null> {
    const API_ENDPOINT = getServerUrl();

    // Generate a new data encryption key for this machine
    const { key: dataKey, encryptedKey } = await encryption.generateDataKey();

    // Encrypt the fields
    const encryptedMetadata = await encryption.encryptWithKey(params.metadata, dataKey);
    const encryptedDirectConfig = params.directConfig
        ? await encryption.encryptWithKey(params.directConfig, dataKey)
        : undefined;
    const encryptedPairingData = params.pairingData
        ? await encryption.encryptWithKey(params.pairingData, dataKey)
        : undefined;

    const body = {
        type: params.type,
        happyMachineId: params.happyMachineId,
        directConfig: encryptedDirectConfig,
        metadata: encryptedMetadata,
        pairingData: encryptedPairingData,
        dataEncryptionKey: encryptedKey,
    };

    const response = await fetch(`${API_ENDPOINT}/v1/moltbot/machines`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        console.error(`Failed to create Moltbot machine: ${response.status}`);
        return null;
    }

    const data = await response.json();
    const raw = data.machine as RawMoltbotMachine;

    return decryptMoltbotMachine(raw, encryption);
}

/**
 * Update a Moltbot machine
 */
export async function updateMoltbotMachine(
    credentials: Credentials,
    encryption: MoltbotEncryption,
    machineId: string,
    dataKey: Uint8Array,
    currentMetadataVersion: number,
    updates: {
        metadata?: MoltbotMetadata;
        pairingData?: MoltbotPairingData;
        directConfig?: MoltbotDirectConfig;
    }
): Promise<MoltbotMachine | null> {
    const API_ENDPOINT = getServerUrl();

    const body: Record<string, unknown> = {};

    if (updates.metadata) {
        body.metadata = await encryption.encryptWithKey(updates.metadata, dataKey);
        body.expectedMetadataVersion = currentMetadataVersion;
    }

    if (updates.pairingData !== undefined) {
        body.pairingData = updates.pairingData
            ? await encryption.encryptWithKey(updates.pairingData, dataKey)
            : null;
    }

    if (updates.directConfig !== undefined) {
        body.directConfig = updates.directConfig
            ? await encryption.encryptWithKey(updates.directConfig, dataKey)
            : null;
    }

    const response = await fetch(`${API_ENDPOINT}/v1/moltbot/machines/${machineId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const error = await response.json();
        console.error(`Failed to update Moltbot machine: ${response.status}`, error);
        return null;
    }

    const data = await response.json();
    const raw = data.machine as RawMoltbotMachine;

    return decryptMoltbotMachine(raw, encryption);
}

/**
 * Delete a Moltbot machine
 */
export async function deleteMoltbotMachine(
    credentials: Credentials,
    machineId: string
): Promise<boolean> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetch(`${API_ENDPOINT}/v1/moltbot/machines/${machineId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        console.error(`Failed to delete Moltbot machine: ${response.status}`);
        return false;
    }

    return true;
}

/**
 * Decrypt a raw Moltbot machine from the server
 */
async function decryptMoltbotMachine(
    raw: RawMoltbotMachine,
    encryption: MoltbotEncryption
): Promise<MoltbotMachine | null> {
    // Decrypt the data encryption key if present
    let dataKey: Uint8Array | null = null;
    if (raw.dataEncryptionKey) {
        dataKey = await encryption.decryptEncryptionKey(raw.dataEncryptionKey);
        if (!dataKey) {
            console.error(`Failed to decrypt data encryption key for Moltbot machine ${raw.id}`);
            return null;
        }
    }

    // If no data key, we can't decrypt the encrypted fields
    if (!dataKey) {
        console.error(`No data encryption key for Moltbot machine ${raw.id}`);
        return null;
    }

    // Validate machine type
    if (raw.type !== 'happy' && raw.type !== 'direct') {
        console.error(`Invalid machine type '${raw.type}' for Moltbot machine ${raw.id}`);
        return null;
    }

    // Decrypt and validate metadata
    let metadata: MoltbotMetadata | null = null;
    if (raw.metadata) {
        try {
            const decrypted = await encryption.decryptWithKey(raw.metadata, dataKey);
            const parseResult = MoltbotMetadataSchema.safeParse(decrypted);
            if (parseResult.success) {
                metadata = parseResult.data;
            } else {
                console.error(`Invalid metadata schema for Moltbot machine ${raw.id}:`, parseResult.error);
            }
        } catch (error) {
            console.error(`Failed to decrypt metadata for Moltbot machine ${raw.id}:`, error);
        }
    }

    // Decrypt and validate directConfig (if type is 'direct')
    let directConfig: MoltbotDirectConfig | null = null;
    if (raw.type === 'direct' && raw.directConfig) {
        try {
            const decrypted = await encryption.decryptWithKey(raw.directConfig, dataKey);
            const parseResult = MoltbotDirectConfigSchema.safeParse(decrypted);
            if (parseResult.success) {
                directConfig = parseResult.data;
            } else {
                console.error(`Invalid directConfig schema for Moltbot machine ${raw.id}:`, parseResult.error);
            }
        } catch (error) {
            console.error(`Failed to decrypt directConfig for Moltbot machine ${raw.id}:`, error);
        }
    }

    // Decrypt and validate pairingData
    let pairingData: MoltbotPairingData | null = null;
    if (raw.pairingData) {
        try {
            const decrypted = await encryption.decryptWithKey(raw.pairingData, dataKey);
            const parseResult = MoltbotPairingDataSchema.safeParse(decrypted);
            if (parseResult.success) {
                pairingData = parseResult.data;
            } else {
                console.error(`Invalid pairingData schema for Moltbot machine ${raw.id}:`, parseResult.error);
            }
        } catch (error) {
            console.error(`Failed to decrypt pairingData for Moltbot machine ${raw.id}:`, error);
        }
    }

    return {
        id: raw.id,
        type: raw.type,
        happyMachineId: raw.happyMachineId,
        gatewayToken: metadata?.gatewayToken ?? null,
        directConfig,
        metadata,
        metadataVersion: raw.metadataVersion,
        pairingData,
        seq: raw.seq,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    };
}

/**
 * Process a new-moltbot-machine update event
 */
export async function processNewMoltbotMachineEvent(
    eventData: {
        machineId: string;
        machineType: 'happy' | 'direct';
        happyMachineId: string | null;
        directConfig: string | null;
        metadata: string;
        metadataVersion: number;
        pairingData: string | null;
        dataEncryptionKey: string | null;
        seq: number;
        createdAt: number;
        updatedAt: number;
    },
    encryption: MoltbotEncryption
): Promise<MoltbotMachine | null> {
    const raw: RawMoltbotMachine = {
        id: eventData.machineId,
        type: eventData.machineType,
        happyMachineId: eventData.happyMachineId,
        directConfig: eventData.directConfig,
        metadata: eventData.metadata,
        metadataVersion: eventData.metadataVersion,
        pairingData: eventData.pairingData,
        dataEncryptionKey: eventData.dataEncryptionKey,
        seq: eventData.seq,
        createdAt: eventData.createdAt,
        updatedAt: eventData.updatedAt,
    };

    return decryptMoltbotMachine(raw, encryption);
}

/**
 * Process an update-moltbot-machine event
 */
export async function processUpdateMoltbotMachineEvent(
    eventData: {
        machineId: string;
        metadata?: { value: string; version: number };
        pairingData?: string | null;
        directConfig?: string | null;
    },
    currentMachine: MoltbotMachine,
    encryption: MoltbotEncryption,
    dataKey: Uint8Array
): Promise<MoltbotMachine> {
    const updated = { ...currentMachine };

    if (eventData.metadata) {
        try {
            const decrypted = await encryption.decryptWithKey(eventData.metadata.value, dataKey);
            const parseResult = MoltbotMetadataSchema.safeParse(decrypted);
            if (parseResult.success) {
                updated.metadata = parseResult.data;
                updated.metadataVersion = eventData.metadata.version;
            } else {
                console.error(`Invalid metadata schema in update for Moltbot machine ${eventData.machineId}:`, parseResult.error);
            }
        } catch (error) {
            console.error(`Failed to decrypt metadata update for Moltbot machine ${eventData.machineId}:`, error);
        }
    }

    if (eventData.pairingData !== undefined) {
        if (eventData.pairingData === null) {
            updated.pairingData = null;
        } else {
            try {
                const decrypted = await encryption.decryptWithKey(eventData.pairingData, dataKey);
                const parseResult = MoltbotPairingDataSchema.safeParse(decrypted);
                if (parseResult.success) {
                    updated.pairingData = parseResult.data;
                } else {
                    console.error(`Invalid pairingData schema in update for Moltbot machine ${eventData.machineId}:`, parseResult.error);
                }
            } catch (error) {
                console.error(`Failed to decrypt pairingData update for Moltbot machine ${eventData.machineId}:`, error);
            }
        }
    }

    if (eventData.directConfig !== undefined) {
        if (eventData.directConfig === null) {
            updated.directConfig = null;
        } else {
            try {
                const decrypted = await encryption.decryptWithKey(eventData.directConfig, dataKey);
                const parseResult = MoltbotDirectConfigSchema.safeParse(decrypted);
                if (parseResult.success) {
                    updated.directConfig = parseResult.data;
                } else {
                    console.error(`Invalid directConfig schema in update for Moltbot machine ${eventData.machineId}:`, parseResult.error);
                }
            } catch (error) {
                console.error(`Failed to decrypt directConfig update for Moltbot machine ${eventData.machineId}:`, error);
            }
        }
    }

    return updated;
}
