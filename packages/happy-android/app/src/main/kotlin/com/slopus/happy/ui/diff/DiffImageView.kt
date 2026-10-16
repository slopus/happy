package com.slopus.happy.ui.diff

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Base64

/**
 * DiffImageView.tsx: before and after side by side, padding 12, 12 apart;
 * an added or deleted image shows the one side it has. Each pane is a
 * label (mono semibold 10.5, uppercase, markerDel / markerAdd) 6 above a
 * 160 high box (1 divider border, radius 6, hunkBg) with the picture
 * fitted inside. Neither side: "Binary file", 13 textSecondary, padded 16.
 * [before] and [after] are `data:` URIs.
 */
@Composable
fun DiffImageView(before: String?, after: String?, modifier: Modifier = Modifier) {
    val palette = diffPalette()
    if (before == null && after == null) {
        Box(modifier = modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.diff_binary_file), style = happyTextStyle(fontSize = 13), color = palette.textSecondary)
        }
        return
    }
    Row(
        modifier = modifier.fillMaxWidth().testTag(DiffTags.IMAGE).background(palette.surface).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (before != null) Pane(before, stringResource(R.string.diff_image_before), palette.markerDel, palette, Modifier.weight(1f))
        if (after != null) Pane(after, stringResource(R.string.diff_image_after), palette.markerAdd, palette, Modifier.weight(1f))
    }
}

@Composable
private fun Pane(uri: String, label: String, tint: Color, palette: DiffPalette, modifier: Modifier) {
    val bitmap by produceState<ImageBitmap?>(null, uri) { value = withContext(Dispatchers.Default) { decodeDataUri(uri) } }
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label.uppercase(), style = DiffHeaderSpec.badge, color = tint, maxLines = 1)
        // A fixed height keeps the two sides comparable; fitting means neither is cropped.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(160.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(palette.hunkBg)
                .border(1.dp, palette.divider, RoundedCornerShape(6.dp)),
        ) {
            bitmap?.let { Image(it, contentDescription = label, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
        }
    }
}

/** `data:<mime>;base64,<data>` to a bitmap; null when it isn't one. */
internal fun decodeDataUri(uri: String): ImageBitmap? {
    val comma = uri.indexOf(',')
    if (!uri.startsWith("data:") || comma < 0 || !uri.substring(0, comma).endsWith(";base64")) return null
    val bytes = runCatching { Base64.getDecoder().decode(uri.substring(comma + 1)) }.getOrNull() ?: return null
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}
