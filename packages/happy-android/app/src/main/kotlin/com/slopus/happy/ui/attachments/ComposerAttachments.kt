package com.slopus.happy.ui.attachments

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentNotice
import com.slopus.happy.attachments.AttachmentServices
import com.slopus.happy.attachments.AttachmentSendPlan
import com.slopus.happy.attachments.AttachmentUploadResult
import com.slopus.happy.attachments.prepareAttachmentSend
import com.slopus.happy.attachments.readAttachmentBytes
import com.slopus.happy.attachments.supportsImageAttachmentsForFlavor
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1
import com.slopus.happy.sync.rigCanUseAttachments
import com.slopus.happy.text.plural
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import android.content.res.Resources

/** The open chat's image picker; null where the session takes no images (no strip, no add button). */
val LocalComposerImages = compositionLocalOf<ImagePicker?> { null }

/** SessionView.tsx `canUseAttachments`: the rig's capability for rig v1 sessions, else the flavor. */
fun canUseAttachments(metadata: SessionMetadata?): Boolean =
    if (metadata.isRigV1()) metadata.rigCanUseAttachments() else supportsImageAttachmentsForFlavor(metadata?.flavor)

/**
 * [ImagePicker] for a chat, or null when [enabled] is false. Like
 * SessionView, images picked while attachments were allowed are dropped
 * when they stop being allowed.
 */
@Composable
fun rememberComposerImages(enabled: Boolean): ImagePicker? {
    val picker = rememberImagePicker()
    LaunchedEffect(enabled, picker.images.size) {
        if (!enabled && picker.images.isNotEmpty()) picker.clear()
    }
    return picker.takeIf { enabled }
}

/** The composer's attachment strip (above the input). Nothing without a picker or images. */
@Composable
fun ComposerAttachmentStrip() {
    val picker = LocalComposerImages.current ?: return
    AttachmentStrip(picker.images, onRemove = picker::remove)
}

/** The composer's add-image button (in the action row). Nothing without a picker. */
@Composable
fun ComposerAddImageButton() {
    val picker = LocalComposerImages.current ?: return
    AddImageButton(attached = picker.images.isNotEmpty(), onClick = picker::attach)
}

/** Whether images wait to be sent: the send button is live with images and no text. */
@Composable
fun hasComposerImages(): Boolean = LocalComposerImages.current?.images?.isNotEmpty() == true

/**
 * sync.ts sendMessage's attachment half for [sessionId]: plans, uploads
 * over the account's transfers, and returns the file event records to hand
 * to `ChatActions.send` with the text, plus the alerts to show.
 */
suspend fun prepareComposerAttachments(
    graph: AppGraph,
    sessionId: String,
    metadata: SessionMetadata?,
    text: String,
    picker: ImagePicker?,
): AttachmentSendPlan {
    val images = picker?.images?.toList().orEmpty()
    val transfers = AttachmentServices.of(graph).transfers
    return prepareAttachmentSend(metadata, text, images) { list ->
        transfers?.upload(sessionId, list, ::readAttachmentBytes) ?: AttachmentUploadResult(emptyList(), list.size)
    }
}

/** The alert for a send notice (imageUpload.notSupported / uploadFailed). */
fun attachmentNoticeAlert(notice: AttachmentNotice, resources: Resources): Alert {
    val ok = listOf(AlertButton(resources.getString(R.string.common_ok)))
    return when (notice) {
        AttachmentNotice.NotSupported -> Alert(
            resources.getString(R.string.image_upload_not_supported_title),
            resources.getString(R.string.image_upload_not_supported_message),
            ok,
        )
        is AttachmentNotice.UploadFailed -> Alert(
            resources.getString(R.string.image_upload_upload_failed_title),
            resources.plural(R.plurals.image_upload_upload_failed_message, notice.count, notice.count),
            ok,
        )
    }
}
