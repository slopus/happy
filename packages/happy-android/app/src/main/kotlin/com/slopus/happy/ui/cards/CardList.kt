package com.slopus.happy.ui.cards

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * The card lists' sizes (iOS's `CardListMetrics`, `CardListLayout`): the
 * agent home's inset grouped cards as a list of their own, for the screens
 * home opens (the artifacts; Surfaces and todo lists next).
 *
 * ```
 * |16| HEADING ………………………………………………………… |16|
 * |16| card: |16| tile |12| title ………… trailing |16| |16|
 *                          subtitle ……………………………
 *                          ……… hairline to the card's edge
 * ```
 *
 * Every slot is held to the content column first ([contentMaxWidth]), so
 * on a fold or tablet the cards keep the readable column, centred.
 */
object CardListSpec {
    /** The cards' inset from the column's edges, and their corners: home's and Settings'. */
    val side = HomeCardSpec.inset
    val radius = HomeCardSpec.radius
    /** The tile's and the text's start from the card's left; the trailing text's end from its right. */
    val inset = 16.dp
    /** A heading's box, its 18 line standing 7 above the card. */
    val headingHeight = 36.dp
    val headingBottom = 7.dp
    /** From a card down to the next heading. */
    val headingGap = 14.dp
    val contentTop = 8.dp
    val contentBottom = 24.dp
    /** A thumbnail's or a glyph tile's square. */
    val tile = 40.dp
    val tileRadius = 8.dp
    val tileGlyph = 20.dp
    val tileGap = 12.dp
    /** Above the first line and below the last. */
    val padding = 10.dp
    /** Between the title and the subtitle. */
    val lineGap = 2.dp
    /** Between the title and what trails it. */
    val trailingGap = 8.dp
    /** A row with a tile is never shorter than the tile and its padding; a plain row than 44. */
    val tiledRow = 60.dp
    val plainRow = 44.dp
    /** A note in place of rows: 24 above and below. */
    val notePadding = 24.dp

    val title = happyTextStyle(fontSize = 16, lineHeight = 20)
    val subtitle = happyTextStyle(fontSize = 13, lineHeight = 16)
    val heading = happyTextStyle(fontSize = 13, lineHeight = 18, letterSpacing = 13 * 0.02f, weight = FontWeight.Medium)
    val note = happyTextStyle(fontSize = 15, lineHeight = 20)
}

object CardListTags {
    const val HEADING = "cards.heading"
    const val ROW = "cards.row"
    const val TITLE = "cards.row.title"
    const val SUBTITLE = "cards.row.subtitle"
    const val TRAILING = "cards.row.trailing"
    const val LEADING = "cards.row.leading"
    const val DIVIDER = "cards.row.divider"
    const val NOTE = "cards.note"
}

/**
 * A section's heading over its card (iOS's `CardHeadingLayout`): 13/18
 * medium, upper case, secondary, from where the rows' content starts, 7
 * above the card in a 36 box; [afterCard] adds the 14 down from the card
 * before it. [trailing] (13 regular) ends on the rows' content edge.
 */
@Composable
fun CardHeading(text: String, afterCard: Boolean, modifier: Modifier = Modifier, trailing: String? = null) {
    val colors = HappyTheme.colors
    Row(
        modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .testTag(CardListTags.HEADING)
            .padding(top = if (afterCard) CardListSpec.headingGap else 0.dp)
            .height(CardListSpec.headingHeight)
            .padding(horizontal = CardListSpec.side + CardListSpec.inset)
            .padding(bottom = CardListSpec.headingBottom),
        verticalAlignment = Alignment.Bottom,
    ) {
        Text(
            text.uppercase(),
            style = CardListSpec.heading,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        if (!trailing.isNullOrEmpty()) {
            Spacer(Modifier.width(CardListSpec.trailingGap))
            Text(trailing, style = CardListSpec.heading.copy(fontWeight = FontWeight.Normal, letterSpacing = CardListSpec.subtitle.letterSpacing), color = colors.textSecondary, maxLines = 1)
        }
    }
}

/**
 * One row of a card (iOS's `CardRowLayout`): [leading] (a 40 tile or
 * picture) 16 in, the [title] (16/20, up to [titleLines]) 12 after it, or
 * 16 in without one, [subtitle] (13/16 secondary) 2 under it, [trailing]
 * (13/16 secondary) on the title's first line, ending 16 in. As tall as the
 * text and 10 above and below, never under 60 with a tile or 44 without;
 * the text centred. The card's ground (`surfaceHigh`) rounds 26 at the top
 * of the first row and the bottom of the last; a hairline runs under every
 * other row from the text's start to the card's edge. A press highlights
 * within the card's corners.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CardRow(
    place: HomeCardPlace,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    trailing: String? = null,
    leading: (@Composable BoxScope.() -> Unit)? = null,
    titleLines: Int = 2,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    /** Marks the whole slot. */
    tag: String = CardListTags.ROW,
    /** Drawn over the row inside its slot: a menu anchored to it. */
    overlay: @Composable BoxScope.() -> Unit = {},
) {
    val colors = HappyTheme.colors
    val radius = CardListSpec.radius
    val shape = RoundedCornerShape(
        topStart = if (place.first) radius else 0.dp,
        topEnd = if (place.first) radius else 0.dp,
        bottomStart = if (place.last) radius else 0.dp,
        bottomEnd = if (place.last) radius else 0.dp,
    )
    val textStart = CardListSpec.inset + if (leading != null) CardListSpec.tile + CardListSpec.tileGap else 0.dp
    Box(
        modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .testTag(tag)
            .padding(horizontal = CardListSpec.side),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(colors.surfaceHigh)
                .then(
                    if (onClick != null || onLongClick != null) {
                        Modifier.combinedClickable(role = Role.Button, onClick = onClick ?: {}, onLongClick = onLongClick)
                    } else {
                        Modifier
                    },
                ),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = if (leading != null) CardListSpec.tiledRow else CardListSpec.plainRow)
                    .padding(horizontal = CardListSpec.inset, vertical = CardListSpec.padding),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (leading != null) {
                    Box(Modifier.size(CardListSpec.tile).testTag(CardListTags.LEADING), contentAlignment = Alignment.Center, content = leading)
                    Spacer(Modifier.width(CardListSpec.tileGap))
                }
                Column(Modifier.weight(1f)) {
                    Row {
                        Text(
                            title,
                            style = CardListSpec.title,
                            color = colors.text,
                            maxLines = titleLines,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).alignByBaseline().testTag(CardListTags.TITLE),
                        )
                        if (trailing != null) {
                            Spacer(Modifier.width(CardListSpec.trailingGap))
                            Text(
                                trailing,
                                style = CardListSpec.subtitle,
                                color = colors.textSecondary,
                                maxLines = 1,
                                modifier = Modifier.alignByBaseline().testTag(CardListTags.TRAILING),
                            )
                        }
                    }
                    if (subtitle != null) {
                        Text(
                            subtitle,
                            style = CardListSpec.subtitle,
                            color = colors.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = CardListSpec.lineGap).testTag(CardListTags.SUBTITLE),
                        )
                    }
                }
            }
            if (!place.last) {
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = textStart)
                        .fillMaxWidth()
                        .height(hairline())
                        .background(colors.divider)
                        .testTag(CardListTags.DIVIDER),
                )
            }
        }
        overlay()
    }
}

/** A kind's glyph (20) on its softly tinted 40 tile, rounded 8: home's tile tints. */
@Composable
fun CardTile(glyph: Ionicon, tint: RowTile, modifier: Modifier = Modifier) {
    val dark = HappyTheme.colors.dark
    Box(
        modifier.size(CardListSpec.tile).clip(RoundedCornerShape(CardListSpec.tileRadius)).background(tint.fill(dark)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(glyph, CardListSpec.tileGlyph, tint.ink(dark))
    }
}

/**
 * A quiet line in place of the rows (iOS's `CardNoteLayout`): 15/20
 * secondary, centred in the column inside the cards' content edges, 24
 * above and below.
 */
@Composable
fun CardNote(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = CardListSpec.note,
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .testTag(CardListTags.NOTE)
            .padding(horizontal = CardListSpec.side + CardListSpec.inset, vertical = CardListSpec.notePadding),
    )
}

/** The places of [count] rows in one card, in order (iOS's `CardPlace.run`). */
fun cardPlaces(count: Int): List<HomeCardPlace> = List(count) { HomeCardPlace(first = it == 0, last = it == count - 1) }
