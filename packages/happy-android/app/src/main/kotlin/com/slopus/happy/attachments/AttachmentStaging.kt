package com.slopus.happy.attachments

import android.net.Uri
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID

/** Why a pick did not go: too big for this chat, or its bytes could not be read. */
sealed interface StagingProblem {
    val name: String

    data class TooLarge(override val name: String, val maxMb: Int) : StagingProblem
    data class Unreadable(override val name: String) : StagingProblem
}

/** Picks made ready to send, in the order they were picked, and the ones that could not be. */
data class Staged(val attachments: List<AttachmentPreview>, val problems: List<StagingProblem>)

/**
 * Turns the attachment sheet's picks into files of the app's own, before
 * the sheet closes and its URIs may stop being readable: a photo as the
 * composer has always sent one ([ImageNormalizer]: upright, at most 3072,
 * JPEG 0.92), a video or any other file copied as it is. Each lands in its
 * own directory under [directory], so two picks of one name never collide.
 * Anything larger than [AttachAccepts.maxFileBytes] is left out and said.
 */
class AttachmentStaging(
    private val directory: File,
    private val open: (PickedMedia) -> InputStream,
) {
    fun stage(items: List<PickedMedia>, accepts: AttachAccepts): Staged {
        val attachments = ArrayList<AttachmentPreview>(items.size)
        val problems = ArrayList<StagingProblem>()
        val maxMb = (accepts.maxFileBytes / (1024 * 1024)).toInt()
        for (item in items) {
            if (!accepts.fits(item.size)) {
                problems += StagingProblem.TooLarge(item.name, maxMb)
                continue
            }
            try {
                val staged = if (item.kind == PickedKind.Photo) photo(item) ?: copy(item, accepts.maxFileBytes) else copy(item, accepts.maxFileBytes)
                if (staged == null) {
                    problems += StagingProblem.TooLarge(item.name, maxMb)
                } else if (staged.size > accepts.maxFileBytes) {
                    Uri.parse(staged.uri).path?.let { File(it).delete() }
                    problems += StagingProblem.TooLarge(item.name, maxMb)
                } else {
                    attachments += staged
                }
            } catch (_: IOException) {
                problems += StagingProblem.Unreadable(item.name)
            } catch (_: SecurityException) {
                problems += StagingProblem.Unreadable(item.name)
            }
        }
        return Staged(attachments, problems)
    }

    /** The photo re-encoded, or null when its bytes aren't a picture Android decodes (sent as a file then). */
    private fun photo(item: PickedMedia): AttachmentPreview? {
        val normalized = try {
            ImageNormalizer.normalize({ open(item) }, item.name, newDirectory())
        } catch (e: IOException) {
            return null
        }
        return AttachmentPreview(
            id = UUID.randomUUID().toString(),
            uri = Uri.fromFile(normalized.file).toString(),
            width = normalized.width,
            height = normalized.height,
            mimeType = normalized.mimeType,
            size = normalized.size,
            name = normalized.name,
        )
    }

    /** The bytes as they are; null once more than [max] were read. */
    private fun copy(item: PickedMedia, max: Long): AttachmentPreview? {
        val file = File(newDirectory(), safeAttachmentName(item.name))
        var total = 0L
        open(item).use { input ->
            file.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > max) {
                        output.close()
                        file.delete()
                        return null
                    }
                    output.write(buffer, 0, read)
                }
            }
        }
        return AttachmentPreview(
            id = UUID.randomUUID().toString(),
            uri = Uri.fromFile(file).toString(),
            width = item.width,
            height = item.height,
            mimeType = item.mimeType,
            size = total,
            name = item.name,
        )
    }

    private fun newDirectory(): File = File(directory, UUID.randomUUID().toString()).apply { mkdirs() }
}

/**
 * iOS's AttachmentRules.safeName: the name's last path part, with the
 * characters Windows and shells trip on replaced, control characters
 * dropped, trimmed of spaces and dots, at most 120 bytes; "attachment"
 * when nothing is left.
 */
fun safeAttachmentName(name: String): String {
    val leaf = name.replace('\\', '/').split('/').lastOrNull { it.isNotEmpty() } ?: ""
    val portable = leaf.map { if (it in "<>:\"|?*") '_' else it }.filterNot { it.isISOControl() }.joinToString("")
    val clean = portable.trim { it.isWhitespace() || it == '.' }
    val bounded = StringBuilder()
    var bytes = 0
    var index = 0
    while (index < clean.length) {
        val codePoint = clean.codePointAt(index)
        val text = String(Character.toChars(codePoint))
        val size = text.toByteArray(Charsets.UTF_8).size
        if (bytes + size > 120) break
        bounded.append(text)
        bytes += size
        index += Character.charCount(codePoint)
    }
    return bounded.toString().trim { it.isWhitespace() || it == '.' }.ifEmpty { "attachment" }
}
