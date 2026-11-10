package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.ui.UiMediaLayout
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlin.math.roundToInt

object UiMediaTags {
    /** The row; its items' tiles are [ConversationMediaTags.TILE] and [FILE]. */
    const val FLOW = "conversation.ui.media"
    const val LABEL = "conversation.ui.media.label"
    const val FILE = "conversation.ui.media.file"
}

object UiMediaSpec {
    /** An item's label, and a file's name in its tile. */
    val label = happyTextStyle(fontSize = 13, lineHeight = 18)
    val fileGlyph = 24.dp
    val fileGlyphGap = 6.dp
    val filePadding = 8.dp
}

/**
 * A chat UI `media` component. Spec: 16 in from the sides and 6 above and
 * below, as every row; its items in justified rows by the one rule every
 * client shares ([UiMediaLayout]), at the room between the insets, from the
 * sizes the items state alone, so the row's height is known before a byte
 * arrives and nothing moves when one does. A picture or recording covers
 * its box ([MediaTile]: radius 8, a divider hairline) and opens in the
 * viewer; a file is a surfaceHigh box of the same radius, a 24 document
 * glyph 6 over its name (13/18, two lines, centred), and opens as a file
 * card does. Under each labelled item its label: one 13/18 textSecondary
 * line 4 below, cut with an ellipsis.
 */
@Composable
fun UiMediaRow(row: ConversationRow.UiMedia, actions: ConversationRowActions, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    // A kept picture read again once its download completes.
    val loads = row.items.map { ref ->
        key(ref.key) {
            if (ref.item.kind != "image") null else rememberMediaBytes(ref, actions.loadMedia, here = actions.kept?.phase(ref)?.isComplete == true)
        }
    }
    val posters = row.items.map { ref -> key(ref.key) { if (ref.item.kind == "video") rememberVideoPoster(ref, actions.loadVideo) else null } }
    val inputs = row.items.mapIndexed { index, ref -> UiMediaLayout.Input(ref.item.kind, ref.item.width, ref.item.height, row.labels[index] != null) }
    Layout(
        content = {
            row.items.forEachIndexed { index, ref ->
                key(ref.key) {
                    if (ref.item.isVisual) PresentedTile(ref, loads[index], posters[index], actions, crop = true, label = row.labels[index]) else FileTile(ref, actions)
                    row.labels[index]?.let { label ->
                        Text(label, style = UiMediaSpec.label, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(UiMediaTags.LABEL))
                    }
                }
            }
        },
        modifier = modifier
            .testTag(UiMediaTags.FLOW)
            .fillMaxWidth()
            .padding(horizontal = ConversationRowSpec.marginHorizontal, vertical = ConversationRowSpec.marginVertical),
    ) { measurables, constraints ->
        val laid = UiMediaLayout.layout(inputs, (constraints.maxWidth / density).toDouble())
        fun px(dp: Double) = (dp * density).roundToInt()
        fun fixed(frame: UiMediaLayout.Frame) = Constraints.fixed(px(frame.x + frame.width) - px(frame.x), px(frame.y + frame.height) - px(frame.y))
        // Each item's tile, then its label where it has one, as they were emitted.
        val boxes = laid.frames.zip(laid.labels).flatMap { (frame, line) -> listOfNotNull(frame, line) }
        val places = measurables.zip(boxes) { measurable, box -> measurable.measure(fixed(box)) to IntOffset(px(box.x), px(box.y)) }
        layout(constraints.maxWidth, px(laid.height)) {
            for ((placeable, at) in places) placeable.place(at)
        }
    }
}

@Composable
private fun FileTile(ref: MediaRef, actions: ConversationRowActions) {
    val colors = HappyTheme.colors
    val open = actions.onOpenMedia
    Column(
        Modifier
            .testTag(UiMediaTags.FILE)
            .fillMaxSize()
            .clip(RoundedCornerShape(ConversationMediaSpec.radius))
            .background(colors.surfaceHigh)
            .then(if (open != null) Modifier.clickable(role = Role.Button) { open(ref) } else Modifier)
            .padding(UiMediaSpec.filePadding),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Ionicon.DocumentTextOutline, UiMediaSpec.fileGlyph, colors.textSecondary)
        Spacer(Modifier.height(UiMediaSpec.fileGlyphGap))
        Text(ref.item.name, style = UiMediaSpec.label, color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }
}
