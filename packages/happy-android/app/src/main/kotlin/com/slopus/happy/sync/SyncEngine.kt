package com.slopus.happy.sync

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
 *   messages   for sessions whose server `seq` is ahead of the stored run:
 *              the newest page (`before_seq`) if nothing is stored yet,
 *              then `/v3/sessions/:id/messages?after_seq=` from the run's
 *              end (see [MessageSync]). Older history loads on demand.
 *
 * Each stream runs even if another failed; [syncAll] reports the failures
 * and the caller retries. Every write and its watermark commit together, so
 * an interrupted run resumes where it stopped.
 *
 * Live updates (the `/v1/updates` socket, [LiveUpdates]) write through the
 * same store methods; a sync runs on sign-in, on every socket (re)connect
 * and whenever the app returns to the foreground.
 */
class SyncEngine(
    private val api: SyncApi,
    private val store: HappyStore,
    private val encryption: AccountEncryption,
    private val clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val decoder: RecordDecoder = RecordDecoder(encryption),
    private val messages: MessageSync = MessageSync(api, store, decoder, CoroutineScope(SupervisorJob() + io), io),
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
            // sync.ts: settingsToSyncPayload(applySettings(settings, pending)).
            val payload = Settings.syncPayload(Settings.apply(base?.value ?: EMPTY, pending))
            val result = api.updateSettings(cipher.encryptToBase64(payload), base?.version ?: 0)
            when {
                result.success -> {
                    store.transaction {
                        store.saveSettings(payload, result.version ?: ((base?.version ?: 0) + 1))
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
        store.replaceMachines(api.machines().mapNotNull(decoder::machine))
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
            store.upsertSessions(page.sessions.mapNotNull(decoder::session))
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

    // Messages

    /** Catches up every session the server has newer messages for; one that has none stored starts from its newest page. */
    internal suspend fun syncMessages() {
        for ((sessionId, _) in store.sessionsBehind()) {
            messages.catchUp(sessionId)
        }
    }

    companion object {
        const val CURSOR_SESSIONS_CHANGED = "sessions.changedSince"
        const val CURSOR_SESSIONS_LISTED_AT = "sessions.listedAt"
        const val SESSION_PAGE_SIZE = 200
        const val MAX_SETTINGS_ATTEMPTS = 3
        const val FULL_LISTING_INTERVAL_MS = 24L * 60 * 60 * 1000
        private val EMPTY = JsonObject(emptyMap())
    }
}
