package com.slopus.happy.ui.vaults

import android.media.MediaDataSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.artifacts.RangedSource
import com.slopus.happy.conversation.MediaFiles
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.ui.conversation.PictureViewer
import com.slopus.happy.ui.conversation.ViewerSource
import com.slopus.happy.vaults.VaultDownloads
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultPreview
import com.slopus.happy.vaults.VaultPreviewKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.File

/**
 * A folder's pictures and recordings in the conversation's viewer
 * ([PictureViewer]), as Finder's Quick Look pages through a folder:
 * swiped between in the folder's order, opening at [index]. A picture is
 * read whole; a recording plays in its page read a range at a time, of
 * the version shown when it opened. Share sends the item as a file named
 * as the vault names it. [version] shows an earlier version of a single
 * entry (history's preview).
 */
@Composable
fun VaultMediaViewer(session: AgentSession, items: List<VaultItem>, index: Int, version: Int? = null, onClose: () -> Unit) {
    val routes = session.vaults.routes
    val pages = remember(items, version) {
        items.map { entry -> ViewerItem(key(entry, version), entry.name, VaultPreview.kind(entry) == VaultPreviewKind.Video) }
    }
    val byKey = remember(items, version) { items.associateBy { key(it, version) } }
    val source = remember(routes, byKey) {
        object : ViewerSource {
            override suspend fun bytes(key: String): ByteArray? {
                val entry = byKey[key] ?: return null
                return try {
                    routes.content(entry.surfaceId, entry.id, version ?: entry.latestVersion).body
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    android.util.Log.w("VaultMediaViewer", "Couldn't read ${entry.id}: ${e.javaClass.simpleName} ${e.message}")
                    null
                }
            }

            override fun video(key: String): MediaDataSource? {
                val entry = byKey[key] ?: return null
                val number = version ?: entry.latestVersion
                val size = if (version == null || version == entry.latestVersion) entry.size ?: 0L else 0L
                return RangedSource(size) { start, end -> runBlocking { routes.content(entry.surfaceId, entry.id, number, "bytes=$start-$end") } }
            }

            override val shares: Boolean get() = true

            override suspend fun shareable(key: String, directory: File): File? {
                val entry = byKey[key] ?: return null
                return withContext(Dispatchers.IO) {
                    val target = File(directory, MediaFiles.safeName(entry.name, VaultDownloads.mediaType(entry)))
                    target.outputStream().use { VaultDownloads.write(routes, entry, version ?: entry.latestVersion, if (version == null) entry.size else null, it) }
                    target
                }
            }
        }
    }
    PictureViewer(pages, index.coerceIn(0, (pages.size - 1).coerceAtLeast(0)), source, onClose)
}

/** A version of an entry is the same picture wherever it shows, so it is cached by that. */
private fun key(entry: VaultItem, version: Int?): String = "vault/${entry.surfaceId}/${entry.id}/${version ?: entry.latestVersion ?: 0}"
