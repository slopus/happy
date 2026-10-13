package com.slopus.happy.sync

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MachineRecord
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.IOException

/**
 * Brings the local store up to date with the server, fetching only what
 * changed since the last run:
 *
 *   settings   upload pending local changes (optimistic concurrency on the
 *              settings version, merge and retry on a conflict), then read
 *   profile    small, read whole
 *   machines   small, the endpoint has no delta: read whole, replace
 *   sessions   `/v2/sessions?changedSince=` from the stored watermark, paged
 *              by cursor. A session's `updatedAt` moves with every message,
 *              so this also says which sessions have new messages. A full
 *              listing (no `changedSince`) runs on first sync and then daily,
 *              because deletions do not show up in a delta.
 *   messages   `/v3/sessions/:id/messages?after_seq=` from each session's
 *              local watermark, for sessions whose server `seq` is ahead
 *
 * Each stream runs even if another failed; [syncAll] reports the failures
 * and the caller retries. Every write and its watermark commit together, so
 * an interrupted run resumes where it stopped.
 *
 * Live updates (the `/v1/updates` socket) will write through the same store
 * methods; until then a sync runs on sign-in and whenever the app returns to
 * the foreground.
 */
class SyncEngine(
    private val api: SyncApi,
    private val store: HappyStore,
    private val encryption: AccountEncryption,
    private val clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutex = Mutex()

    /** Runs every stream once. Returns the streams' failures; empty means fully synced. */
    suspend fun syncAll(): List<Exception> = mutex.withLock {
        withContext(io) {
            buildList {
                step { syncSettings() }
                step { syncProfile() }
                step { syncMachines() }
                step { syncSessions() }
                step { syncMessages() }
            }
        }
    }

    private suspend fun MutableList<Exception>.step(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            add(e)
        }
    }

    // Settings (sync.ts syncSettings)

    internal suspend fun syncSettings() {
        val cipher = encryption.settingsCipher()
        var attempts = 0
        while (true) {
            val pending = store.pendingSettings()
            if (pending.isEmpty()) break
            if (attempts == MAX_SETTINGS_ATTEMPTS) {
                throw IOException("Settings sync failed after $MAX_SETTINGS_ATTEMPTS attempts due to version conflicts")
            }
            attempts++
            val base = store.settings()
            val merged = JsonObject((base?.value ?: EMPTY) + pending)
            val result = api.updateSettings(cipher.encryptToBase64(merged), base?.version ?: 0)
            when {
                result.success -> {
                    store.transaction {
                        store.saveSettings(merged, result.version ?: ((base?.version ?: 0) + 1))
                        // Changes made while the request was in flight stay pending.
                        store.savePendingSettings(JsonObject(store.pendingSettings().filter { (key, value) -> pending[key] != value }))
                    }
                    break
                }
                result.error == "version-mismatch" -> {
                    // Server copy becomes the base; pending changes go on top of it next round.
                    val current = result.currentSettings?.let { decryptSettings(cipher, it) } ?: EMPTY
                    store.saveSettings(current, result.currentVersion ?: 0)
                }
                else -> throw IOException("Failed to sync settings: ${result.error}")
            }
        }

        val remote = api.settings()
        store.saveSettings(remote.settings?.let { decryptSettings(cipher, it) } ?: EMPTY, remote.settingsVersion)
    }

    private fun decryptSettings(cipher: PayloadCipher, encrypted: String): JsonObject? =
        cipher.decryptFromBase64(encrypted) as? JsonObject

    // Profile and machines

    internal suspend fun syncProfile() {
        store.saveProfile(api.profile())
    }

    internal suspend fun syncMachines() {
        store.replaceMachines(api.machines().mapNotNull(::decodeMachine))
    }

    private fun decodeMachine(machine: ApiMachine): MachineRecord? {
        val wrapped = machine.dataEncryptionKey ?: return null
        val cipher = encryption.decryptDataEncryptionKey(wrapped)?.let(encryption::dataKeyCipher) ?: return null
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

    // Sessions

    internal suspend fun syncSessions() {
        val watermark = store.cursor(CURSOR_SESSIONS_CHANGED)
        val listedAt = store.cursor(CURSOR_SESSIONS_LISTED_AT)
        val now = clock()
        val fullListing = watermark == null || listedAt == null || now - listedAt >= FULL_LISTING_INTERVAL_MS
        // One millisecond back: a session updated in the same millisecond as
        // the newest one seen, but committed after that read, is not lost.
        // Fetching the boundary record again is harmless.
        val changedSince = if (fullListing) null else maxOf(1, watermark - 1)

        var cursor: String? = null
        var newest = watermark ?: 0L
        val listed = HashSet<String>()
        do {
            val page = api.sessions(cursor, changedSince, SESSION_PAGE_SIZE)
            store.upsertSessions(page.sessions.mapNotNull(::decodeSession))
            for (session in page.sessions) {
                listed += session.id
                newest = maxOf(newest, session.updatedAt)
            }
            cursor = page.nextCursor
        } while (page.hasNext && cursor != null)

        store.transaction {
            if (fullListing) {
                store.retainSessions(listed)
                store.setCursor(CURSOR_SESSIONS_LISTED_AT, now)
            }
            store.setCursor(CURSOR_SESSIONS_CHANGED, newest)
        }
    }

    /**
     * Null for a session this device cannot read: one from the retired
     * protocol (no data key), or one whose key or metadata does not open.
     * One bad record must not stop the rest of the page.
     */
    private fun decodeSession(session: ApiSession): SessionRecord? {
        val wrapped = session.dataEncryptionKey ?: return null
        val cipher = encryption.decryptDataEncryptionKey(wrapped)?.let(encryption::dataKeyCipher) ?: return null
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
        )
    }

    // Messages

    internal suspend fun syncMessages() {
        for ((sessionId, storedSeq) in store.sessionsBehind()) {
            val session = store.session(sessionId) ?: continue
            val cipher = encryption.decryptDataEncryptionKey(session.wrappedDataKey)?.let(encryption::dataKeyCipher) ?: continue
            var afterSeq = storedSeq
            try {
                do {
                    val page = api.messagesAfter(sessionId, afterSeq, MESSAGE_PAGE_SIZE)
                    if (page.messages.isEmpty()) break
                    store.insertMessages(sessionId, page.messages.map { decodeMessage(sessionId, it, cipher) })
                    afterSeq = page.messages.maxOf { it.seq }
                } while (page.hasMore)
            } catch (e: HttpStatusException) {
                if (e.status != 404) throw e
                store.deleteSessions(listOf(sessionId))
                continue
            }
            // Everything up to the seq the listing reported is here now, even
            // if some of those seqs had no message to return.
            store.markMessagesSynced(sessionId, session.seq)
        }
    }

    private fun decodeMessage(sessionId: String, message: ApiMessage, cipher: PayloadCipher) = MessageRecord(
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

    companion object {
        const val CURSOR_SESSIONS_CHANGED = "sessions.changedSince"
        const val CURSOR_SESSIONS_LISTED_AT = "sessions.listedAt"
        const val SESSION_PAGE_SIZE = 200
        const val MESSAGE_PAGE_SIZE = 500
        const val MAX_SETTINGS_ATTEMPTS = 3
        const val FULL_LISTING_INTERVAL_MS = 24L * 60 * 60 * 1000
        private val EMPTY = JsonObject(emptyMap())
    }
}
