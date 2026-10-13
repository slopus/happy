package com.slopus.happy.data

/**
 * Decrypted rows as the store hands them out. JSON columns stay JSON text:
 * the store does not interpret what sessions and machines carry, the
 * features that read them do.
 */
data class SessionRecord(
    val id: String,
    /** The server's latest message seq for this session. */
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    val metadataJson: String?,
    val metadataVersion: Long,
    val agentStateJson: String?,
    val agentStateVersion: Long,
    /** The record's data key, still wrapped to the account (base64, as on the wire). */
    val wrappedDataKey: String,
    val projectId: String?,
)

data class MessageRecord(
    val sessionId: String,
    val seq: Long,
    val id: String,
    val localId: String?,
    /** Decrypted message JSON, or null if this device could not open it. */
    val contentJson: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

data class MachineRecord(
    val id: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    val metadataJson: String?,
    val metadataVersion: Long,
    val daemonStateJson: String?,
    val daemonStateVersion: Long,
    val wrappedDataKey: String,
)
