package com.slopus.happy.ui.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme

/**
 * The shared card shell for content that is not CardRow's title/subtitle:
 * todo editors, charts and meters. The same 16 dp side inset, 26 dp corners
 * and readable column apply. Content decides height, so scaled text grows.
 * [dividerStart] is measured from the card edge, before its content padding.
 */
@Composable
fun CardBlock(
    place: HomeCardPlace,
    modifier: Modifier = Modifier,
    dividerStart: Dp = CardListSpec.inset,
    tag: String = "cards.block",
    content: @Composable BoxScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    val radius = CardListSpec.radius
    val shape = RoundedCornerShape(
        topStart = if (place.first) radius else 0.dp,
        topEnd = if (place.first) radius else 0.dp,
        bottomStart = if (place.last) radius else 0.dp,
        bottomEnd = if (place.last) radius else 0.dp,
    )
    Box(modifier.contentMaxWidth(LocalWindowLayout.current).testTag(tag).padding(horizontal = CardListSpec.side)) {
        Box(Modifier.fillMaxWidth().clip(shape).background(colors.surfaceHigh).testTag("$tag.body")) {
            content()
            if (place.separated) {
                Box(
                    Modifier.align(Alignment.BottomStart).padding(start = dividerStart)
                        .fillMaxWidth().height(hairline()).background(colors.divider).testTag("$tag.divider"),
                )
            }
        }
    }
}