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
    /** Device-local: when this device last had a message accepted for the session (storage.ts markSessionMessageSent). */
    val lastMessageSentAt: Long? = null,
    /** The session avatar's descriptor JSON as the server sent it (its preview still sealed), or null. */
    val avatarJson: String? = null,
    /** The avatar's server revision (`avatarVersion`), when known. */
    val avatarRevision: Long? = null,
    /** The seq of the live update that last set the avatar; null when a listing did. */
    val avatarUpdateSeq: Long? = null,
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

/**
 * What is stored of a session's messages: the contiguous run
 * [oldestSeq]..[newestSeq], or nothing yet ([isLoaded] false).
 */
data class MessageHistory(
    val isLoaded: Boolean,
    val oldestSeq: Long,
    val newestSeq: Long,
    /** The server has messages older than [oldestSeq]. */
    val hasOlder: Boolean,
)

enum class OutboxKind(val wire: String) { USER("user"), ATTACHMENT("attachment") }

/**
 * Delivery of one accepted message. `SENT` means the server stored it (the
 * POST answered) but its echo is not in `messages` yet; the row goes when
 * the echo arrives. `FAILED` waits for the user to retry or discard.
 */
enum class OutboxState { QUEUED, SENDING, SENT, FAILED }

data class OutboxRecord(
    val localId: String,
    val sessionId: String,
    val kind: OutboxKind,
    /** The plaintext raw record (RawRecord JSON), as the reducer reads it. */
    val recordJson: String,
    /** The encrypted record, base64, exactly as it is POSTed. */
    val content: String,
    val createdAt: Long,
    val state: OutboxState,
    val attempts: Int,
    val error: String?,
    val serverId: String?,
    val serverSeq: Long?,
)

/** Whether a session or machine is online, as its stored row says. */
data class ActivityRow(val id: String, val active: Boolean, val activeAt: Long)
