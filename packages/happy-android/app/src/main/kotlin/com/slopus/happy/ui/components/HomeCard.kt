package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme

object HomeCardTags {
    const val DIVIDER = "homeCard.divider"
}

/**
 * Home's inset cards, the same on an agent connection's home and a Happy
 * account's (iOS's GroupedSidebarTokens and HomeCardLayout): each card a
 * quiet rounded block on the page's own surface, 16 in from the window's
 * sides, 24 between two.
 */
object HomeCardSpec {
    val inset = 16.dp
    val radius = 26.dp
    val gap = 24.dp
    /** Above the first card. */
    val contentTop = 8.dp
    /** A row's corner dot: waiting or unread. */
    val dot = 10.dp
}

/**
 * Where a row stands in its card (iOS's HomeCardPlace): the [first]
 * rounds the card's top corners, the [last] its bottom ones; a [separated]
 * row has a hairline under it.
 */
@Immutable
data class HomeCardPlace(val first: Boolean, val last: Boolean, val separated: Boolean = !last)

/**
 * One row's part of its card: [height] high in the content column, the
 * card's ground ([HappyTheme] `surfaceHigh`) with its top corners rounded
 * on the first row and its bottom ones on the last, a pressed row's
 * highlight clipped to them, and, when [HomeCardPlace.separated], a
 * hairline under the row from [dividerStart] (where its text starts, from
 * the card's edge) to the card's edge. [tag] marks the whole row.
 */
@Composable
fun HomeCardRow(
    place: HomeCardPlace,
    height: Dp,
    dividerStart: Dp,
    modifier: Modifier = Modifier,
    tag: String? = null,
    /** The row of what the tablet's main panel shows: its ground is the selected one. */
    selected: Boolean = false,
    content: @Composable BoxScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    val radius = HomeCardSpec.radius
    val shape = RoundedCornerShape(
        topStart = if (place.first) radius else 0.dp,
        topEnd = if (place.first) radius else 0.dp,
        bottomStart = if (place.last) radius else 0.dp,
        bottomEnd = if (place.last) radius else 0.dp,
    )
    Box(
        modifier = modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .height(height)
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .then(if (selected) Modifier.semantics { this.selected = true } else Modifier)
            .padding(horizontal = HomeCardSpec.inset),
    ) {
        Box(Modifier.fillMaxSize().clip(shape).background(if (selected) colors.surfaceSelected else colors.surfaceHigh)) {
            content()
            if (place.separated) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = dividerStart)
                        .fillMaxWidth()
                        .height(hairline())
                        .testTag(HomeCardTags.DIVIDER)
                        .background(colors.divider),
                )
            }
        }
    }
}
