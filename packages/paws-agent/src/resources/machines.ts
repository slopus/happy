import type { Machine, MachinesResource } from '../client/types';
import { decryptRecordField, RecordEncryptionStore, resolveRecordEncryption } from '../crypto/records';
import type { PawsHttpTransport } from '../transport/http';

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
}
