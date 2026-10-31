package com.slopus.happy.attachments

import android.content.Context
import android.content.Intent
import android.net.Uri
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** A file sent from the File tab, for its Recent files. */
@Serializable
data class RecentFile(
    val uri: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val sentAt: Long,
) {
    fun picked(): PickedMedia = PickedMedia(uri, PickedKind.File, name, mimeType, size)
}

/**
 * The File tab's Recent files. Telegram lists Downloads, which an app can't
 * read on Android 11 and later without all-files access; this lists what
 * was picked through Browse here instead, newest first, each kept readable
 * across restarts with a persisted read grant. Device-only, wiped with the
 * last account ([clear]).
 */
class RecentFiles(private val context: Context, private val now: () -> Long = System::currentTimeMillis) {
    private val prefs get() = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** What is still readable: a file whose grant was lost (deleted, revoked) drops out. */
    fun list(): List<RecentFile> {
        val granted = try {
            context.contentResolver.persistedUriPermissions.filter { it.isReadPermission }.map { it.uri.toString() }.toSet()
        } catch (_: Exception) {
            emptySet()
        }
        return read().filter { it.uri in granted || it.uri.startsWith("file:") }
    }

    /** Keeps [files] (picked with Browse) at the top, with a read grant that outlives this run. */
    fun remember(files: List<PickedMedia>) {
        if (files.isEmpty()) return
        val time = now()
        val added = files.map { RecentFile(it.uri, it.name, it.mimeType, it.size, time) }
        for (file in added) {
            try {
                context.contentResolver.takePersistableUriPermission(Uri.parse(file.uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: SecurityException) {
                // A provider that grants only this once: listed until the grant goes.
            }
        }
        val kept = (added + read().filter { old -> added.none { it.uri == old.uri } }).take(MAX)
        val dropped = read().filter { old -> kept.none { it.uri == old.uri } }
        dropped.forEach(::release)
        write(kept)
    }

    private fun read(): List<RecentFile> = try {
        prefs.getString(KEY, null)?.let { json.decodeFromString(ListSerializer(RecentFile.serializer()), it) }.orEmpty()
    } catch (_: Exception) {
        emptyList()
    }

    private fun write(files: List<RecentFile>) {
        prefs.edit().putString(KEY, json.encodeToString(ListSerializer(RecentFile.serializer()), files)).apply()
    }

    private fun release(file: RecentFile) {
        try {
            context.contentResolver.releasePersistableUriPermission(Uri.parse(file.uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {
        }
    }

    /** With the last account: the list and the grants it held. */
    fun clear() {
        read().forEach(::release)
        prefs.edit().clear().commit()
    }

    companion object {
        const val PREFS_NAME = "attach-recent-files"
        private const val KEY = "files"
        /** Telegram's recent list is long; ours is what was sent from here. */
        const val MAX = 30
        private val json = Json { ignoreUnknownKeys = true }
    }
}
