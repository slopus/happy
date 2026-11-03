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
 * `Conversation.send`): every attachment, pictures included, is written into
 * the agent's workspace under `.happy-uploads/<message>/<n>-<name>`, at most
 * 50 MB a file, and the message text lists their paths. The agent opens
 * what it needs to see; nothing is pushed into its context as an image
 * block. Pictures of the four types the phone draws, up to 5 MB each and
 * 29 MB together, are also read here to show in the bubble while it goes.
 */
object WorkspaceUploads {
    const val DIRECTORY = ".happy-uploads"
    /** Keeps the folder out of git: written before a workspace's first upload ([ConversationApi.ignoreUploads]). */
    const val IGNORE_PATH = "$DIRECTORY/.gitignore"
    const val IGNORE_CONTENT = "*"
    private val drawnTypes = setOf("image/jpeg", "image/png", "image/gif", "image/webp")

    /**
     * For message [messageId]: the pictures the bubble draws from the
     * phone's copies, and every attachment as a workspace file, in order.
     */
    fun split(messageId: String, attachments: List<AttachmentPreview>): Pair<List<AttachmentPreview>, List<OutgoingFile>> {
        val drawn = ArrayList<AttachmentPreview>()
        val files = ArrayList<OutgoingFile>()
        var drawnBytes = 0L
        attachments.forEachIndexed { index, attachment ->
            val size = attachment.size
            if (attachment.mimeType in drawnTypes && size <= InlinePictures.MAX_BYTES && drawnBytes + size <= InlinePictures.MAX_TOTAL_BYTES) {
                drawn += attachment
                drawnBytes += size
            }
            val local = localFile(attachment.uri)
            val name = "$index-${safeAttachmentName(attachment.name)}"
            files += OutgoingFile(local, attachment.name, attachment.mimeType, size, "$DIRECTORY/$messageId/$name")
        }
        return drawn to files
    }

    /** The staged copy a `file:` URI names. */
    fun localFile(uri: String): File = File(runCatching { java.net.URI(uri).path }.getOrNull() ?: uri.removePrefix("file://"))

    /**
     * iOS AttachmentRules.text: the message's words, then where its files
     * are, in the words every Happy client gives the agent (happy-cli's
     * `formatAttachmentNote`), with paths relative to its workspace.
     */
    fun text(text: String, files: List<OutgoingFile>): String {
        if (files.isEmpty()) return text
        val one = files.size == 1
        val noun = if (files.all { it.mimeType.startsWith("image/") }) "image" else "file"
        val count = if (one) "1 $noun" else "${files.size} ${noun}s"
        val pronoun = if (one) "It was" else "They were"
        val obj = if (one) "it" else "them"
        val heading = "The user attached $count. $pronoun saved on this machine and not loaded into your context; " +
            "open $obj with your file-reading or image-viewing tool only if you need to see $obj:"
        val paths = files.joinToString("\n") { "- ./${it.path}" }
        return (if (text.isEmpty()) "" else "$text\n\n") + heading + "\n" + paths
    }
}
