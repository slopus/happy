package com.slopus.happy.sync

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.data.MachineRecord
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.SessionAvatarDescriptor
import com.slopus.happy.model.parseSessionAvatarRevision

/**
 * Turns the server's encrypted records into stored rows. Data keys arrive
 * wrapped to the account; unwrapping one is a public-key operation, so the
 * ciphers are kept by wrapped key (a live chat would otherwise unwrap once
 * per message).
 *
 * A record this device cannot read decodes to null: one from the retired
 * protocol (no data key), or one whose key or payload does not open. One bad
 * record must not stop the rest. A machine of the retired protocol is the
 * exception ([machine]): it is kept, unread, so the person sees it.
 */
class RecordDecoder(val encryption: AccountEncryption) {
    private val ciphers = object : LinkedHashMap<String, PayloadCipher>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, PayloadCipher>) = size > MAX_CIPHERS
    }

    /** The cipher of a record's data key, or null if it does not unwrap. */
    fun cipher(wrappedDataKey: String): PayloadCipher? {
        synchronized(ciphers) { ciphers[wrappedDataKey]?.let { return it } }
        val cipher = encryption.decryptDataEncryptionKey(wrappedDataKey)?.let(encryption::dataKeyCipher) ?: return null
        synchronized(ciphers) { ciphers[wrappedDataKey] = cipher }
        return cipher
    }

    /** The unwrapped data key itself, for the one place it must leave: resume fallback (ops.ts). */
    fun dataKey(wrappedDataKey: String): ByteArray? = encryption.decryptDataEncryptionKey(wrappedDataKey)

    fun session(session: ApiSession): SessionRecord? {
        val wrapped = session.dataEncryptionKey ?: return null
        val cipher = cipher(wrapped) ?: return null
        val metadata = cipher.decryptFromBase64(session.metadata) ?: return null
        val agentState = session.agentState?.let { cipher.decryptFromBase64(it) ?: return null }
        return SessionRecord(
            id = session.id,
            seq = session.seq,
            createdAt = session.createdAt,
            updatedAt = session.updatedAt,
            active = session.active,
            activeAt = session.activeAt,
            metadataJson = metadata.toString(),
            metadataVersion = session.metadataVersion,
            agentStateJson = agentState?.toString(),
            agentStateVersion = session.agentStateVersion,
            wrappedDataKey = wrapped,
            projectId = session.projectId,
            avatarJson = SessionAvatarDescriptor.parse(session.avatar)?.toJson()?.toString(),
            avatarRevision = parseSessionAvatarRevision(session.avatarVersion),
        )
    }

    /**
     * A machine with no data key is a computer a Happy CLI before the data
     * keys (0.9) linked, still signed in with the account secret. It is not
     * decrypted ([MachineRecord.LEGACY_KEY], nothing read): it is kept so the
     * person sees it, named for what it needs, `happy auth login --force`.
     */
    fun machine(machine: ApiMachine): MachineRecord? {
        val wrapped = machine.dataEncryptionKey ?: return MachineRecord(
            id = machine.id,
            seq = machine.seq,
            createdAt = machine.createdAt,
            updatedAt = machine.updatedAt,
            active = machine.active,
            activeAt = machine.activeAt,
            metadataJson = null,
            metadataVersion = machine.metadataVersion,
            daemonStateJson = null,
            daemonStateVersion = machine.daemonStateVersion,
            wrappedDataKey = MachineRecord.LEGACY_KEY,
        )
        val cipher = cipher(wrapped) ?: return null
        val metadata = cipher.decryptFromBase64(machine.metadata) ?: return null
        val daemonState = machine.daemonState?.let { cipher.decryptFromBase64(it) ?: return null }
        return MachineRecord(
            id = machine.id,
            seq = machine.seq,
            createdAt = machine.createdAt,
            updatedAt = machine.updatedAt,
            active = machine.active,
            activeAt = machine.activeAt,
            metadataJson = metadata.toString(),
            metadataVersion = machine.metadataVersion,
            daemonStateJson = daemonState?.toString(),
            daemonStateVersion = machine.daemonStateVersion,
            wrappedDataKey = wrapped,
        )
    }

    /** A message is stored even if it does not open (content null), so the seq run stays whole. */
    fun message(sessionId: String, message: ApiMessage, cipher: PayloadCipher) = MessageRecord(
        sessionId = sessionId,
        seq = message.seq,
        id = message.id,
        localId = message.localId,
        contentJson = message.content
            .takeIf { it.t == "encrypted" }
            ?.let { cipher.decryptFromBase64(it.c) }
            ?.toString(),
        createdAt = message.createdAt,
        updatedAt = message.updatedAt,
    )

    private companion object {
        const val MAX_CIPHERS = 256
    }
}
