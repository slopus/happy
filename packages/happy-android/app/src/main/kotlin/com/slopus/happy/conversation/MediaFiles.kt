package com.slopus.happy.conversation

import java.io.File

/**
 * Where a conversation's media is put for another app to read: one
 * directory of its own under the cache, nothing else of the app's, and one
 * file per presented item. The names the agent sends are not trusted: only
 * the leaf is kept, anything a path could be built from is dropped, and a
 * file always ends in the extension its type says.
 */
object MediaFiles {
    /** The one directory the file provider shares. */
    const val DIRECTORY = "conversation-media"

    private const val MAX_NAME = 96

    private val extensions = mapOf(
        "video/mp4" to "mp4",
        "video/quicktime" to "mov",
        "video/webm" to "webm",
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
        "image/gif" to "gif",
        "application/pdf" to "pdf",
        "text/plain" to "txt",
        "text/markdown" to "md",
        "application/json" to "json",
        "application/zip" to "zip",
    )

    /** A name safe to write: its leaf alone, ASCII-ish, bounded, ending in [mimeType]'s extension. */
    fun safeName(name: String, mimeType: String): String {
        val leaf = name.replace('\\', '/').substringAfterLast('/')
        val cleaned = leaf.replace(Regex("\\s+"), " ")
            .filter { it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' || it == ' ' }
            .trim(' ', '.')
        val extension = extensions[mimeType.substringBefore(';').trim().lowercase()]
        val stem = cleaned.substringBeforeLast('.', cleaned).ifEmpty { "attachment" }.take(MAX_NAME)
        val had = cleaned.substringAfterLast('.', "").takeIf { it.isNotEmpty() && it.length <= 8 }
        return stem + "." + (extension ?: had ?: "bin")
    }

    /**
     * [bytes] written for [item] under [cache]'s own media directory, in a
     * directory of this item's [key] so two items never collide, and
     * replaced if it is already there. The file is the app's alone until a
     * read is granted for it.
     */
    fun stage(cache: File, key: String, item: MediaItem, bytes: ByteArray): File {
        val group = File(File(cache, DIRECTORY), key.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(64).ifEmpty { "item" })
        group.mkdirs()
        val file = File(group, safeName(item.name, item.mimeType))
        // Nothing outside the shared directory, whatever the name carried.
        require(file.canonicalFile.startsWith(File(cache, DIRECTORY).canonicalFile)) { "Outside the media directory" }
        file.writeBytes(bytes)
        return file
    }
}
