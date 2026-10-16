package com.slopus.happy.ui.attachments

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.theme.HappyTheme

object AttachmentStripSpec {
    val thumb = 64.dp
    val radius = 8.dp
    val border = 1.dp
    val gap = 8.dp
    val contentPaddingHorizontal = 4.dp
    val marginHorizontal = 8.dp
    val marginBottom = 8.dp
    val remove = 18.dp
    val removeOffset = 6.dp
    val removeIcon = 10.dp
    const val PRESSED_OPACITY = 0.7f
    val addHeight = 32.dp
    val addPaddingHorizontal = 8.dp
    val addPaddingVertical = 6.dp
    val addRadius = 20.dp
    val addIcon = 16.dp

    /** theme.ts `radio.active`: the add button's tint while images are attached. */
    fun radioActive(dark: Boolean) = if (dark) Color(0xFF0A84FF) else Color(0xFF007AFF)
}

object AttachmentStripTags {
    const val STRIP = "attachments.strip"
    const val THUMB = "attachments.thumb"
    const val REMOVE = "attachments.remove"
    const val ADD = "attachments.add"
}

/**
 * AgentInputAttachmentStrip.tsx: the attached images above the composer's
 * input, in a horizontal scroller. Spec: 8 side margins and 8 below; the
 * row padded 4 at the ends with 8 between thumbnails. Each thumbnail is
 * 64x64, radius 8, a 1 divider border, the image cropped to fill. Its
 * remove button is an 18 circle in surfaceHigh straddling the top right
 * corner (6 outside on both edges), close 10 in text, at 0.7 while
 * pressed. Nothing when there are no images.
 */
@Composable
fun AttachmentStrip(images: List<AttachmentPreview>, onRemove: (String) -> Unit, modifier: Modifier = Modifier) {
    if (images.isEmpty()) return
    LazyRow(
        modifier = modifier
            .testTag(AttachmentStripTags.STRIP)
            .fillMaxWidth()
            .padding(horizontal = AttachmentStripSpec.marginHorizontal)
            .padding(bottom = AttachmentStripSpec.marginBottom),
        // Room above for the remove buttons, which stick out of each thumbnail.
        contentPadding = PaddingValues(horizontal = AttachmentStripSpec.contentPaddingHorizontal, vertical = AttachmentStripSpec.removeOffset),
        horizontalArrangement = Arrangement.spacedBy(AttachmentStripSpec.gap),
    ) {
        items(images, key = { it.id }) { image -> AttachmentThumbnail(image, onRemove) }
    }
}

@Composable
private fun AttachmentThumbnail(image: AttachmentPreview, onRemove: (String) -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(AttachmentStripSpec.radius)
    Box(modifier = Modifier.size(AttachmentStripSpec.thumb).testTag(AttachmentStripTags.THUMB)) {
        Box(
            modifier = Modifier
                .size(AttachmentStripSpec.thumb)
                .clip(shape)
                .border(AttachmentStripSpec.border, colors.divider, shape),
        ) {
            RemoteImage(image.uri, contentDescription = image.name, contentScale = ContentScale.Crop, modifier = Modifier.size(AttachmentStripSpec.thumb))
        }
        val interaction = remember { MutableInteractionSource() }
        val pressed by interaction.collectIsPressedAsState()
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset(x = AttachmentStripSpec.removeOffset, y = -AttachmentStripSpec.removeOffset)
                .zIndex(10f)
                .testTag(AttachmentStripTags.REMOVE)
                .size(AttachmentStripSpec.remove)
                .alpha(if (pressed) AttachmentStripSpec.PRESSED_OPACITY else 1f)
                .background(colors.surfaceHigh, CircleShape)
                .clickable(interaction, indication = null, role = Role.Button) { onRemove(image.id) }
                .semantics { contentDescription = "Remove ${image.name}" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Ionicon.Close, AttachmentStripSpec.removeIcon, colors.text)
        }
    }
}

/**
 * AgentInput's add-image button: 32 high, padded 8/6, radius 20 (Android),
 * image-outline 16 in the secondary button tint, or radio.active while
 * images are attached; 0.7 while pressed. TalkBack reads AgentInput's
 * literal "Add photo" (HomeDock's own button says "Add image").
 */
@Composable
fun AddImageButton(attached: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = modifier
            .testTag(AttachmentStripTags.ADD)
            .height(AttachmentStripSpec.addHeight)
            .alpha(if (pressed) AttachmentStripSpec.PRESSED_OPACITY else 1f)
            .clip(RoundedCornerShape(AttachmentStripSpec.addRadius))
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .padding(horizontal = AttachmentStripSpec.addPaddingHorizontal, vertical = AttachmentStripSpec.addPaddingVertical)
            .semantics { contentDescription = "Add photo" },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Ionicon.ImageOutline,
            AttachmentStripSpec.addIcon,
            if (attached) AttachmentStripSpec.radioActive(colors.dark) else colors.button.secondaryTint,
        )
    }
}
