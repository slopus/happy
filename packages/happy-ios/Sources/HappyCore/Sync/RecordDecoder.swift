import Foundation
import HappyStore
import HappyWire

/// Turns server rows into store records: opens the data key, decrypts the
/// versioned fields, and keeps the ciphertext next to the plaintext.
struct RecordDecoder: Sendable {
    let keyRing: KeyRing

    func session(_ row: APISession, previous: SessionRecord? = nil, avatarUpdateSeq: Int? = nil) -> SessionRecord {
        let cipher = keyRing.cipher(wrappedKey: row.dataEncryptionKey)
        let sameKey = previous?.dataKeyCipher == row.dataEncryptionKey
        let cachedMetadata = sameKey && previous?.metadataVersion == row.metadataVersion
            && previous?.metadataCipher == row.metadata ? previous?.metadata : nil
        let cachedAgentState = sameKey && previous?.agentStateVersion == row.agentStateVersion
            && previous?.agentStateCipher == row.agentState ? previous?.agentState : nil
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
            metadata: cachedMetadata ?? cipher?.decrypt(base64: row.metadata),
            agentStateVersion: row.agentStateVersion,
            agentStateCipher: row.agentState,
            agentState: cachedAgentState ?? row.agentState.flatMap { cipher?.decrypt(base64: $0) },
            dataKeyCipher: row.dataEncryptionKey,
            // Keep the GET revision distinct from the descriptor version:
            // older servers need the before-fetch socket checkpoint even
            // when their descriptor happens to have a higher version.
            decryptable: cipher != nil, avatar: row.avatar, avatarVersion: row.avatarVersion,
            avatarUpdateSeq: avatarUpdateSeq
        )
    }

    func machine(_ row: APIMachine, previous: MachineRecord? = nil) -> MachineRecord {
        let cipher = keyRing.cipher(wrappedKey: row.dataEncryptionKey)
        let sameKey = previous?.dataKeyCipher == row.dataEncryptionKey
        let cachedMetadata = sameKey && previous?.metadataVersion == row.metadataVersion
            && previous?.metadataCipher == row.metadata ? previous?.metadata : nil
        let cachedDaemonState = sameKey && previous?.daemonStateVersion == row.daemonStateVersion
            && previous?.daemonStateCipher == row.daemonState ? previous?.daemonState : nil
        return MachineRecord(
            id: row.id,
            seq: row.seq,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            active: row.active,
            activeAt: row.activeAt,
            metadataVersion: row.metadataVersion,
            metadataCipher: row.metadata,
            metadata: cachedMetadata ?? cipher?.decrypt(base64: row.metadata),
            daemonStateVersion: row.daemonStateVersion,
            daemonStateCipher: row.daemonState,
            daemonState: cachedDaemonState ?? row.daemonState.flatMap { cipher?.decrypt(base64: $0) },
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

    func versioned(_ value: VersionedValue?, cipher: RecordCipher?, after version: Int? = nil) -> VersionedPayload? {
        guard let value, version.map({ value.version > $0 }) ?? true else { return nil }
        return VersionedPayload(
            version: value.version,
            cipher: value.value,
            value: value.value.flatMap { cipher?.decrypt(base64: $0) }
        )
    }
}
