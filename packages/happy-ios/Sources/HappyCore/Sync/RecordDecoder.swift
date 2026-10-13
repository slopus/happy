import Foundation
import HappyStore
import HappyWire

/// Turns server rows into store records: opens the data key, decrypts the
/// versioned fields, and keeps the ciphertext next to the plaintext.
struct RecordDecoder: Sendable {
    let keyRing: KeyRing

    func session(_ row: APISession) -> SessionRecord {
        let cipher = keyRing.cipher(wrappedKey: row.dataEncryptionKey)
        return SessionRecord(
            id: row.id,
            seq: row.seq,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            active: row.active,
            activeAt: row.activeAt,
            projectId: row.projectId,
            metadataVersion: row.metadataVersion,
            metadataCipher: row.metadata,
            metadata: cipher?.decrypt(base64: row.metadata),
            agentStateVersion: row.agentStateVersion,
            agentStateCipher: row.agentState,
            agentState: row.agentState.flatMap { cipher?.decrypt(base64: $0) },
            dataKeyCipher: row.dataEncryptionKey,
            decryptable: cipher != nil
        )
    }

    func machine(_ row: APIMachine) -> MachineRecord {
        let cipher = keyRing.cipher(wrappedKey: row.dataEncryptionKey)
        return MachineRecord(
            id: row.id,
            seq: row.seq,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            active: row.active,
            activeAt: row.activeAt,
            metadataVersion: row.metadataVersion,
            metadataCipher: row.metadata,
            metadata: cipher?.decrypt(base64: row.metadata),
            daemonStateVersion: row.daemonStateVersion,
            daemonStateCipher: row.daemonState,
            daemonState: row.daemonState.flatMap { cipher?.decrypt(base64: $0) },
            dataKeyCipher: row.dataEncryptionKey,
            decryptable: cipher != nil
        )
    }

    func message(_ message: SessionMessage, sessionId: String, cipher: RecordCipher?) -> MessageRecord {
        MessageRecord(
            id: message.id,
            sessionId: sessionId,
            seq: message.seq,
            localId: message.localId,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            contentCipher: message.content.c,
            content: cipher?.decrypt(base64: message.content.c)
        )
    }

    func versioned(_ value: VersionedValue?, cipher: RecordCipher?) -> VersionedPayload? {
        guard let value else { return nil }
        return VersionedPayload(
            version: value.version,
            cipher: value.value,
            value: value.value.flatMap { cipher?.decrypt(base64: $0) }
        )
    }
}
