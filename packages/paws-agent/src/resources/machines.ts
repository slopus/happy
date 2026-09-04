import { PawsAgentError } from '../client/errors';
import type {
    BrowseDirectoryEntry,
    BrowseDirectoryInput,
    BrowseDirectoryResult,
    Machine,
    MachinesResource,
} from '../client/types';
import { decryptRecordField, RecordEncryptionStore, resolveRecordEncryption } from '../crypto/records';
import type { PawsHttpTransport } from '../transport/http';
import type { PawsRealtimeTransport } from '../transport/realtime';

type RawMachine = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string | null;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
};

export class MachinesResourceImpl implements MachinesResource {
    constructor(
        private readonly transport: PawsHttpTransport,
        private readonly realtime: PawsRealtimeTransport,
        private readonly encryption = new RecordEncryptionStore(),
    ) {}

    async list(options: { active?: boolean } = {}): Promise<Machine[]> {
        const snapshot = await this.transport.getWithCredentials<RawMachine[]>('/v1/machines');
        const records = snapshot.data;
        const credentials = snapshot.credentials;

        const machines = records.map(record => {
            const encryption = resolveRecordEncryption(record, credentials, 'machine');
            this.encryption.setMachine(record.id, encryption);
            return {
                id: record.id,
                seq: record.seq,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                active: record.active,
                activeAt: record.activeAt,
                metadata: decryptRecordField(record.metadata, encryption),
                metadataVersion: record.metadataVersion,
                daemonState: decryptRecordField(record.daemonState, encryption),
                daemonStateVersion: record.daemonStateVersion,
            } satisfies Machine;
        });

        return options.active ? machines.filter(machine => machine.active) : machines;
    }

    async browseDirectory(input: BrowseDirectoryInput): Promise<BrowseDirectoryResult> {
        if (!input.machineId.trim()) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'machineId is required');
        }
        const value = await this.realtime.machineRpc<unknown>(input.machineId, 'browseDirectory', {
            path: input.path?.trim() ?? '',
        });
        return this.parseBrowseDirectoryResult(value);
    }

    private parseBrowseDirectoryResult(value: unknown): BrowseDirectoryResult {
        if (!isRecord(value) || typeof value.success !== 'boolean') {
            throw this.malformedBrowseResult();
        }
        if (value.success === false) {
            if (typeof value.error !== 'string' || value.error.length === 0) {
                throw this.malformedBrowseResult();
            }
            return { success: false, error: value.error };
        }
        if (
            typeof value.path !== 'string'
            || (typeof value.parent !== 'string' && value.parent !== null)
            || typeof value.home !== 'string'
            || !Array.isArray(value.directories)
            || !value.directories.every(isBrowseDirectoryEntry)
        ) {
            throw this.malformedBrowseResult();
        }
        return {
            success: true,
            path: value.path,
            parent: value.parent,
            home: value.home,
            directories: value.directories,
        };
    }

    private malformedBrowseResult(): PawsAgentError {
        return new PawsAgentError(
            'PROTOCOL_UNSUPPORTED',
            'Machine RPC returned a malformed directory listing',
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isBrowseDirectoryEntry(value: unknown): value is BrowseDirectoryEntry {
    return isRecord(value)
        && typeof value.name === 'string'
        && typeof value.path === 'string'
        && typeof value.isProjectRoot === 'boolean';
}
