package com.slopus.happy.conversation

import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.safeAttachmentName
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64

/**
 * A file a message takes to the agent through its workspace (iOS's
 * `QueuedFile`): written to [path] in the workspace before the message
 * goes, which then names it. [uploaded] once the computer has it, so a
 * retry writes only what is missing.
 */
class OutgoingFile(val file: File, val name: String, val mimeType: String, val size: Long, val path: String) {
    @Volatile var uploaded: Boolean = false
    /** Its Happy Cloud attachment once uploaded ([ConversationApi.uploadAttachment]). */
    @Volatile var attachmentId: String? = null
}

/** A file a message carries on Happy Cloud: an uploaded attachment's id, and the name it goes by. */
data class SentAttachment(val id: String, val name: String)

/**
 * What a message with attachments sends (iOS's AttachmentRules and
 * `Conversation.send`): pictures of the four types the model reads, up to
 * 5 MB each and 29 MB together, travel inline as image blocks; everything
 * else (videos, documents, a picture past those limits) is written into the
 * agent's workspace under `.happy-uploads/<message>/<n>-<name>`, at most
 * 50 MB a file, and the message text lists their paths so the agent can
 * open them.
 */
object WorkspaceUploads {
    const val DIRECTORY = ".happy-uploads"
    private val inlineTypes = setOf("image/jpeg", "image/png", "image/gif", "image/webp")

    /**
     * [attachments] split into inline pictures and workspace files, in their
     * order, for message [messageId]; [first] numbers them after those the
     * message already has.
     */
    fun split(messageId: String, attachments: List<AttachmentPreview>, first: Int = 0): Pair<List<AttachmentPreview>, List<OutgoingFile>> {
        val inline = ArrayList<AttachmentPreview>()
        val files = ArrayList<OutgoingFile>()
        var inlineBytes = 0L
        attachments.forEachIndexed { index, attachment ->
            val size = attachment.size
            if (attachment.mimeType in inlineTypes && size <= InlinePictures.MAX_BYTES && inlineBytes + size <= InlinePictures.MAX_TOTAL_BYTES) {
                inline += attachment
                inlineBytes += size
            } else {
                val local = localFile(attachment.uri)
                val name = "${first + index}-${safeAttachmentName(attachment.name)}"
                files += OutgoingFile(local, attachment.name, attachment.mimeType, size, "$DIRECTORY/$messageId/$name")
            }
        }
        return inline to files
    }

    /** The staged copy a `file:` URI names. */
    fun localFile(uri: String): File = File(runCatching { java.net.URI(uri).path }.getOrNull() ?: uri.removePrefix("file://"))

    /** Bytes read from the disk at a time for [body]: a multiple of 3, so each piece is whole base64. */
    private const val CHUNK = 3 * 64 * 1024

    /**
     * `PUT …/file`'s JSON for [file] at [path] (`expectedHash: null`, new
     * only), in one array made straight from the disk: the base64 goes into
     * it a piece at a time and the file is never held whole. With the
     * file's SHA-256, which the answer repeats. A file that changes while
     * read fails as unreadable.
     */
    fun body(path: String, file: File): Pair<ByteArray, String> {
        val size = file.length()
        val head = "{\"path\":${JsonPrimitive(path)},\"expectedHash\":null,\"content\":\"".toByteArray(Charsets.UTF_8)
        val tail = "\"}".toByteArray(Charsets.UTF_8)
        val total = head.size + (size + 2) / 3 * 4 + tail.size
        if (total > Int.MAX_VALUE - 8) throw IOException("${file.name} is too large to send")
        val body = ByteArray(total.toInt())
        head.copyInto(body)
        val digest = MessageDigest.getInstance("SHA-256")
        val encoder = Base64.getEncoder()
        val chunk = ByteArray(CHUNK)
        var at = head.size
        var read = 0L
        file.inputStream().use { input ->
            while (true) {
                var filled = 0
                while (filled < chunk.size) {
                    val n = input.read(chunk, filled, chunk.size - filled)
                    if (n < 0) break
                    filled += n
                }
                read += filled
                if (read > size) throw IOException("${file.name} changed while it was read")
                if (filled == 0) break
                digest.update(chunk, 0, filled)
                val encoded = encoder.encode(if (filled == chunk.size) chunk else chunk.copyOf(filled))
                encoded.copyInto(body, at)
                at += encoded.size
                if (filled < chunk.size) break
            }
        }
        if (read != size) throw IOException("${file.name} changed while it was read")
        tail.copyInto(body, at)
        return body to hex(digest.digest())
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** iOS AttachmentRules.text: the message's words, then the files it carries, by path. */
    fun text(text: String, files: List<OutgoingFile>): String = listed(text, files.map { "./${it.path}" })

    /** The message's words, then [names] as [text] lists paths: how a Happy Cloud message's files read in its bubble. */
    fun listed(text: String, names: List<String>): String {
        if (names.isEmpty()) return text
        val heading = if (names.size == 1) "Attached file:" else "Attached files:"
        val lines = names.joinToString("\n") { "- $it" }
        return (if (text.isEmpty()) "" else "$text\n\n") + heading + "\n" + lines
    }

    /** Happy Cloud's largest attachment (`413 attachment_too_large` past it). */
    const val CLOUD_MAX_BYTES = 25L * 1024 * 1024
}
