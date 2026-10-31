package com.slopus.happy.conversation

import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.safeAttachmentName
import java.io.File

/**
 * A file a message takes to the agent through its workspace (iOS's
 * `QueuedFile`): written to [path] in the workspace before the message
 * goes, which then names it. [uploaded] once the computer has it, so a
 * retry writes only what is missing.
 */
class OutgoingFile(val file: File, val name: String, val mimeType: String, val size: Long, val path: String) {
    @Volatile var uploaded: Boolean = false
}

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

    /** [attachments] split into inline pictures and workspace files, in their order, for message [messageId]. */
    fun split(messageId: String, attachments: List<AttachmentPreview>): Pair<List<AttachmentPreview>, List<OutgoingFile>> {
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
                val name = "$index-${safeAttachmentName(attachment.name)}"
                files += OutgoingFile(local, attachment.name, attachment.mimeType, size, "$DIRECTORY/$messageId/$name")
            }
        }
        return inline to files
    }

    /** The staged copy a `file:` URI names. */
    fun localFile(uri: String): File = File(runCatching { java.net.URI(uri).path }.getOrNull() ?: uri.removePrefix("file://"))

    /** iOS AttachmentRules.text: the message's words, then the files it carries, by path. */
    fun text(text: String, files: List<OutgoingFile>): String {
        if (files.isEmpty()) return text
        val heading = if (files.size == 1) "Attached file:" else "Attached files:"
        val paths = files.joinToString("\n") { "- ./${it.path}" }
        return (if (text.isEmpty()) "" else "$text\n\n") + heading + "\n" + paths
    }
}
