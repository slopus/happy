package com.slopus.happy.ui.attachments

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
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
import com.slopus.happy.ui.components.PickerSheetSection
import com.slopus.happy.ui.components.PickerSheetSpec
import com.slopus.happy.ui.conversation.ConversationPopup
import com.slopus.happy.ui.theme.HappyTheme
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

/** A 280 dp floating chooser at the add-image button, with 48 dp actions and a scrollable list. */
@Composable
fun ComposerAddImageButton() {
    val picker = LocalComposerImages.current ?: return
    var open by remember(picker) { mutableStateOf(false) }
    var anchorCenterY by remember { mutableIntStateOf(0) }
    val title = stringResource(R.string.image_upload_attach_title)
    Box(Modifier.onGloballyPositioned { anchorCenterY = it.boundsInWindow().center.y.toInt() }) {
        AddImageButton(attached = picker.images.isNotEmpty(), onClick = { open = !open })
        if (open) ConversationPopup(title, onDismiss = { open = false }, anchorCenterY = anchorCenterY, alignEnd = false, width = 280.dp) {
            Column(Modifier.testTag(ComposerAttachmentTags.MENU).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                PickerSheetSection("attachments", title, separated = false)
                AttachmentMenuAction(ComposerAttachmentTags.PASTE, stringResource(R.string.image_upload_paste_from_clipboard)) {
                    open = false
                    picker.paste()
                }
                AttachmentMenuAction(ComposerAttachmentTags.LIBRARY, stringResource(R.string.image_upload_choose_from_library)) {
                    open = false
                    picker.pick()
                }
            }
        }
    }
}

object ComposerAttachmentTags {
    const val MENU = "composer.attachments.menu"
    const val PASTE = "composer.attachments.paste"
    const val LIBRARY = "composer.attachments.library"
}

@Composable
private fun AttachmentMenuAction(tag: String, label: String, action: () -> Unit) {
    Text(label, style = PickerSheetSpec.label, color = HappyTheme.colors.text,
        modifier = Modifier.testTag(tag).fillMaxWidth().heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = action).padding(horizontal = 24.dp, vertical = 14.dp))
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
