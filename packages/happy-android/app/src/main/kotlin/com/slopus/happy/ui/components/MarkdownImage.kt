package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object MarkdownImageSpec {
    val maxWidth = 520.dp
    val marginVertical = 8.dp
    val gap = 8.dp
    val height = 240.dp
    val radius = 12.dp
    val caption = happyTextStyle(fontSize = 14, lineHeight = 20)
}

object MarkdownImageTags {
    const val BLOCK = "markdown.image"
    const val CAPTION = "markdown.image.caption"
}

/**
 * MarkdownView.tsx `RenderImageBlock`: a column up to 520 wide, left-aligned,
 * 8 above and below, 8 between the picture and its caption. The picture
 * fills the width, 240 high, radius 12, on surfaceHighest, fitted inside
 * (contain); described by the alt text or "Markdown image". The caption is
 * the alt text, 14/20 textSecondary, only when there is one.
 */
@Composable
fun MarkdownImage(alt: String, url: String, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(
        modifier = modifier
            .padding(vertical = MarkdownImageSpec.marginVertical)
            .widthIn(max = MarkdownImageSpec.maxWidth)
            .fillMaxWidth()
            .testTag(MarkdownImageTags.BLOCK),
        verticalArrangement = Arrangement.spacedBy(MarkdownImageSpec.gap),
    ) {
        RemoteImage(
            model = url,
            contentDescription = alt.ifEmpty { "Markdown image" },
            contentScale = ContentScale.Fit,
            background = colors.surfaceHighest,
            modifier = Modifier
                .fillMaxWidth()
                .height(MarkdownImageSpec.height)
                .clip(RoundedCornerShape(MarkdownImageSpec.radius)),
        )
        if (alt.isNotEmpty()) {
            Text(alt, style = MarkdownImageSpec.caption, color = colors.textSecondary, modifier = Modifier.testTag(MarkdownImageTags.CAPTION))
        }
    }
}
