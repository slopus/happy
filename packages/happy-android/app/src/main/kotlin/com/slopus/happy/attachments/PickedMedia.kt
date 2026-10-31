package com.slopus.happy.attachments

import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1

/** What a pick in the attachment sheet is: a gallery photo, a gallery video, or any file. */
enum class PickedKind { Photo, Video, File }

/**
 * One thing picked in the attachment sheet, before it is prepared to send:
 * where it is ([uri], a content or file URI), what it is and how big. Its
 * [key] is the URI, so the same item picked twice is one pick.
 */
data class PickedMedia(
    val uri: String,
    val kind: PickedKind,
    val name: String,
    val mimeType: String,
    /** 0 when the system did not say. */
    val size: Long = 0,
    val width: Int = 0,
    val height: Int = 0,
    val durationMs: Long = 0,
) {
    val key: String get() = uri
    val isVisual: Boolean get() = kind != PickedKind.File
}

/**
 * What a chat takes from the attachment sheet: which tabs it shows and
 * which picks may go.
 *
 * A Happy Agent conversation takes pictures inline and any other file
 * through its workspace (iOS's AttachmentRules: 50 MB a file). A relay
 * session's CLI (happy-cli) reads only pictures from its `file` events, so
 * a relay chat offers photos alone, unless the session's rig says what else
 * it takes (`capabilities.attachments`).
 */
data class AttachAccepts(
    val photos: Boolean,
    val videos: Boolean,
    val files: Boolean,
    /** The largest file that may go, in bytes. */
    val maxFileBytes: Long,
    /** The media types a file may have (one ending in a star takes its whole family); null for any. */
    val fileTypes: List<String>? = null,
    val maxItems: Int = MAX_IMAGES_PER_MESSAGE,
) {
    /** Whether a file of [mimeType] may be picked at all. */
    fun allowsType(mimeType: String): Boolean {
        val types = fileTypes ?: return true
        return types.any { allowed -> allowed == mimeType || (allowed.endsWith("/*") && mimeType.startsWith(allowed.dropLast(1))) }
    }

    /** Whether [size] bytes fit; 0 (unknown) is checked again once the file is copied. */
    fun fits(size: Long): Boolean = size <= 0 || size <= maxFileBytes

    /**
     * The tabs this chat shows: the gallery when it takes photos or videos;
     * the File tab when it takes files, and also for pictures alone, where
     * it holds the system picker and the clipboard.
     */
    val tabs: List<AttachTabKind>
        get() = buildList {
            if (photos || videos) add(AttachTabKind.Gallery)
            if (files || photos) add(AttachTabKind.Files)
        }

    companion object {
        /** iOS AttachmentRules.maxFileBytes. */
        const val AGENT_MAX_FILE_BYTES = 50L * 1024 * 1024

        /** A Happy Agent conversation: everything, files through its workspace. */
        val Agent = AttachAccepts(photos = true, videos = true, files = true, maxFileBytes = AGENT_MAX_FILE_BYTES)

        /** A relay chat with no session yet (the compose chat): pictures. */
        val RelayPictures = AttachAccepts(photos = true, videos = false, files = false, maxFileBytes = MAX_NORMALIZED_FILE_SIZE.toLong())

        /** Nothing: the session takes no attachments. */
        val None = AttachAccepts(photos = false, videos = false, files = false, maxFileBytes = 0)

        /**
         * A relay session: pictures where it takes them; with a rig v1
         * policy, what the policy lists (videos when it takes `video/`,
         * the File tab when it takes anything else), within its size and
         * the server's 10 MB.
         */
        fun relay(metadata: SessionMetadata?, canUseAttachments: Boolean): AttachAccepts {
            if (!canUseAttachments) return None
            val policy = if (metadata.isRigV1()) metadata.rigAttachmentPolicy() else null
            if (policy == null) return RelayPictures
            val max = minOf(policy.maxBytes.toLong().takeIf { it > 0 } ?: Long.MAX_VALUE, MAX_NORMALIZED_FILE_SIZE.toLong())
            val types = policy.mediaTypes
            fun takes(mimeType: String) = isAttachmentAllowedByPolicy(mimeType, 0, policy)
            return AttachAccepts(
                photos = takes("image/jpeg"),
                videos = takes("video/mp4"),
                files = types.any { !it.startsWith("image/") && !it.startsWith("video/") },
                maxFileBytes = max,
                fileTypes = types,
            )
        }
    }
}

/** The sheet's tabs, in Telegram's order. */
enum class AttachTabKind { Gallery, Files }
