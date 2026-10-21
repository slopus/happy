package com.slopus.happy.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ItemTags {
    const val ROW = "item.row"
    const val ICON = "item.icon"
    const val TITLE = "item.title"
    const val SUBTITLE = "item.subtitle"
    const val DETAIL = "item.detail"
    const val CHEVRON = "item.chevron"
}

/** Item.tsx, Android branch. */
object ItemSpec {
    val minHeight = 56.dp
    val paddingHorizontal = 16.dp
    val paddingVertical = 16.dp
    val iconSize = 32.dp
    val iconGap = 12.dp
    val rightSectionGap = 8.dp
    val detailGap = 6.dp
    val chevronSize = 24.dp
    val chevronGap = 4.dp
    val spinnerSize = 20.dp
    val title = happyTextStyle(fontSize = 16, lineHeight = 24, letterSpacing = 0.15f)
    val subtitle = happyTextStyle(fontSize = 14, lineHeight = 20, letterSpacing = 0.1f)
    val detail = happyTextStyle(fontSize = 17, letterSpacing = -0.41f)
}

/**
 * The settings row every list in happy-app is built from.
 *
 * Spec (Android): row min height 56, padding 16 on all sides, content centred
 * vertically. Optional 32x32 icon slot, 12 before the text. Title 16/24
 * (tracking 0.15), one line with a subtitle and two without; subtitle 14/20
 * (tracking 0.1), two lines by default. Right section starts 8 after the text:
 * detail 17 (tracking -0.41) with 6 before the chevron, a 20 spinner while
 * loading, then a 24 chevron 4 after. Dividers are 0 high on Android, so there
 * are none. Pressing shows a ripple; disabled rows are at 50% opacity.
 * TalkBack reads a row as one stop, title then subtitle and detail; a
 * control in [rightElement] (a switch) stays a stop of its own.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Item(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    subtitleLines: Int = 2,
    detail: String? = null,
    icon: (@Composable () -> Unit)? = null,
    rightElement: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    destructive: Boolean = false,
    showChevron: Boolean = true,
    /** `titleStyle={{ color }}`; unspecified keeps the text (or destructive) colour. */
    titleColor: Color = Color.Unspecified,
    /** `detailStyle={{ color }}` */
    detailColor: Color = Color.Unspecified,
    /** `subtitleStyle`, e.g. the monospaced ids on the machine screen. */
    subtitleStyle: TextStyle? = null,
) {
    val colors = HappyTheme.colors
    val interactive = onClick != null || onLongClick != null
    val showAccessory = interactive && showChevron && rightElement == null
    val interactionSource = remember { MutableInteractionSource() }

    val clickModifier = if (interactive) {
        Modifier.combinedClickable(
            interactionSource = interactionSource,
            indication = ripple(color = colors.text),
            enabled = enabled && !loading,
            role = Role.Button,
            onClick = { onClick?.invoke() },
            onLongClick = onLongClick,
        )
    } else {
        Modifier.semantics(mergeDescendants = true) {}
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.5f)
            .then(clickModifier)
            .defaultMinSize(minHeight = ItemSpec.minHeight)
            .testTag(ItemTags.ROW)
            .padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Box(
                modifier = Modifier
                    .padding(end = ItemSpec.iconGap)
                    .size(ItemSpec.iconSize)
                    .testTag(ItemTags.ICON),
                contentAlignment = Alignment.Center,
            ) { icon() }
        }

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            Text(
                text = title,
                style = ItemSpec.title,
                color = titleColor.takeOrElse { if (destructive) colors.textDestructive else colors.text },
                maxLines = if (subtitle != null) 1 else 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag(ItemTags.TITLE),
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = subtitleStyle ?: ItemSpec.subtitle,
                    color = colors.textSecondary,
                    maxLines = if (subtitleLines <= 0) Int.MAX_VALUE else subtitleLines,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag(ItemTags.SUBTITLE),
                )
            }
        }

        Row(
            modifier = Modifier.padding(start = ItemSpec.rightSectionGap),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (detail != null && rightElement == null) {
                Text(
                    text = detail,
                    style = ItemSpec.detail,
                    color = detailColor.takeOrElse { colors.textSecondary },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .padding(end = if (showAccessory) ItemSpec.detailGap else 0.dp)
                        .testTag(ItemTags.DETAIL),
                )
            }
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(end = if (showAccessory) ItemSpec.detailGap else 0.dp)
                        .size(ItemSpec.spinnerSize),
                    color = colors.textSecondary,
                    strokeWidth = 2.dp,
                )
            }
            rightElement?.invoke()
            if (showAccessory) {
                Icon(
                    icon = Ionicon.ChevronForward,
                    size = ItemSpec.chevronSize,
                    color = colors.grouped.chevron,
                    modifier = Modifier
                        .padding(start = ItemSpec.chevronGap)
                        .testTag(ItemTags.CHEVRON),
                )
            }
        }
    }
}
