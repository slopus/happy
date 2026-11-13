package com.slopus.happy.ui.attach

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.photoedit.PhotoEditIcons
import com.slopus.happy.ui.photoedit.PhotoEditMode
import com.slopus.happy.ui.photoedit.PhotoEditSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference

/**
 * The preview's foot, as Telegram's `PhotoViewer` has it while picking:
 * the sheet's caption bar (the same words, and Send), then a capsule of the
 * photo's two edits, Crop and Draw, each in the edited yellow once applied.
 * In the dark theme over the black, riding the keyboard.
 */
@Composable
internal fun AttachViewerFoot(
    caption: String,
    onCaptionChange: (String) -> Unit,
    count: Int,
    sending: Boolean,
    onSend: () -> Unit,
    edited: EditedPhoto?,
    editable: Boolean,
    onEdit: (PhotoEditMode) -> Unit,
    modifier: Modifier = Modifier,
) {
    HappyTheme(preference = ThemePreference.Dark) {
        val colors = remember { AttachColors.of(dark = true) }
        Column(
            modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                .testTag(AttachTags.PREVIEW_FOOT),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AttachCaptionBar(
                caption = caption,
                onCaptionChange = onCaptionChange,
                count = count,
                onSend = onSend,
                sending = sending,
                shown = { 1f },
                backdrop = null,
                colors = colors,
                tags = CaptionTags.Preview,
            )
            if (editable) {
                Row(
                    Modifier
                        .padding(bottom = 8.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(Color.White.copy(alpha = 0.12f)),
                ) {
                    EditButton(PhotoEditIcons.Crop, stringResource(R.string.photo_edit_crop), edited?.cropped == true, AttachTags.PREVIEW_CROP) { onEdit(PhotoEditMode.Crop) }
                    EditButton(PhotoEditIcons.Draw, stringResource(R.string.photo_edit_draw), edited?.drawn == true, AttachTags.PREVIEW_DRAW) { onEdit(PhotoEditMode.Draw) }
                }
            }
        }
    }
}

@Composable
private fun EditButton(icon: ImageVector, label: String, applied: Boolean, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(56.dp, 44.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                selected = applied
            }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = if (applied) PhotoEditSpec.edited else Color.White, modifier = Modifier.size(24.dp))
    }
}
