package com.slopus.happy.attachments

/**
 * A photo picked to send whose own bytes are still being read (iOS
 * `PreviewAttachment`): its [thumbnail], a small JPEG of the same shape,
 * stands in under its ring until [read] brings the staged copy. [read]
 * throws when the photo can't be read; it is left out then.
 */
class PendingPicture(val thumbnail: ByteArray, val read: suspend () -> AttachmentPreview) {
    companion object {
        /** Photos read at once (iOS `ComposerImagePicker.ReadGate`). */
        const val READS = 3
    }
}
