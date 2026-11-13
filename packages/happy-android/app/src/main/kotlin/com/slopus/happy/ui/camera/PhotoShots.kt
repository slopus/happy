package com.slopus.happy.ui.camera

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.slopus.happy.R
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.rememberImageLoader
import com.slopus.happy.ui.conversation.viewerOrigin
import com.slopus.happy.ui.theme.happyTextStyle
import java.util.Locale

/** A photo the camera took while the sheet is open: its viewer key, what draws it (as edited), its pick number (0 when unpicked). */
@Immutable
data class CameraShot(val key: String, val model: Any, val number: Int)

internal object PhotoShotsSpec {
    /** `cameraPhotoRecyclerView`: 80 tall, its cells square. */
    const val STRIP = 80
    /** `counterTextView`: 38 tall, 16 in each side. */
    const val COUNTER = 38
}

/** The shots, newest first, 80 square and 4 apart in from 8; a picked one wears its number. */
@Composable
internal fun PhotoShotStrip(shots: List<CameraShot>, onOpen: (Int) -> Unit, modifier: Modifier) {
    val label = stringResource(R.string.attach_photo_label)
    LazyRow(
        modifier.testTag(PhotoTags.SHOTS),
        contentPadding = PaddingValues(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        itemsIndexed(shots, key = { _, shot -> shot.key }) { index, shot ->
            Box(
                Modifier
                    .size(PhotoShotsSpec.STRIP.dp)
                    .viewerOrigin(shot.key)
                    .clickable(role = Role.Button) { onOpen(index) }
                    .semantics { contentDescription = label }
                    .testTag(PhotoTags.SHOT),
            ) {
                AsyncImage(shot.model, null, imageLoader = rememberImageLoader(), contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
                if (shot.number > 0) {
                    Box(
                        Modifier.align(Alignment.TopEnd).padding(4.dp).size(22.dp).clip(CircleShape).background(Color.White),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("${shot.number}", color = Color.Black, style = happyTextStyle(12, weight = FontWeight.Bold))
                    }
                }
            }
        }
    }
}

/** `counterTextView`: "2 PHOTOS" and an up chevron in bold white on a dark 38 pill; it opens the shots. */
@Composable
internal fun PhotoShotCounter(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .height(PhotoShotsSpec.COUNTER.dp)
            .clip(RoundedCornerShape(19.dp))
            .background(Color.Black.copy(alpha = 0.5f))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp)
            .testTag(PhotoTags.COUNTER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            pluralStringResource(R.plurals.camera_shots, count, count).uppercase(Locale.getDefault()),
            color = Color.White,
            style = happyTextStyle(14, weight = FontWeight.Bold),
            maxLines = 1,
        )
        Icon(MaterialSymbols.ExpandMore, null, tint = Color.White, modifier = Modifier.padding(start = 4.dp).size(18.dp).rotate(180f).fillMaxHeight())
    }
}
