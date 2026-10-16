package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object PickerSheetTags {
    const val PANEL = "pickerSheet"
    const val TITLE = "pickerSheet.title"
    const val CLOSE = "pickerSheet.close"
    fun section(key: String) = "pickerSheet.section.$key"
    fun option(key: String) = "pickerSheet.option.$key"
}

/** PickerSheet.tsx */
object PickerSheetSpec {
    val maxWidth = 640.dp
    val radius = 28.dp
    val rowInset = 24.dp
    val touchTarget = 48.dp
    val headerMinHeight = 56.dp
    val closeIcon = 22.dp
    val optionMinHeight = 56.dp
    val radio = 20.dp
    val radioDot = 10.dp
    val radioGap = 16.dp
    val title = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val sectionTitle = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
    val label = happyTextStyle(fontSize = 16)
    val description = happyTextStyle(fontSize = 13)
}

/**
 * PickerSheetPanel: an opaque surface (radius 28, hairline divider border,
 * at most 640 wide), the title 17 semibold 24 in beside a 48 close button
 * (header at least 56, 4 above), then the options, scrolling within
 * whatever height the panel is given, 8 under the last.
 */
@Composable
fun PickerSheetPanel(
    title: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(PickerSheetSpec.radius)
    Column(
        modifier = modifier
            .testTag(PickerSheetTags.PANEL)
            .widthIn(max = PickerSheetSpec.maxWidth)
            .fillMaxWidth()
            .clip(shape)
            .background(colors.surface)
            .border(hairline(), colors.divider, shape),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = PickerSheetSpec.headerMinHeight)
                .padding(start = PickerSheetSpec.rowInset, end = 4.dp, top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title,
                style = PickerSheetSpec.title,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).testTag(PickerSheetTags.TITLE).semantics { heading() },
            )
            val cancel = stringResource(R.string.common_cancel)
            Box(
                modifier = Modifier
                    .testTag(PickerSheetTags.CLOSE)
                    .size(PickerSheetSpec.touchTarget)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onClose)
                    .semantics { contentDescription = cancel },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.Close, PickerSheetSpec.closeIcon, colors.text)
            }
        }
        Column(modifier = Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(bottom = 8.dp), content = content)
    }
}

/**
 * A group heading (13 semibold secondary, 24 in, 12 above, 4 below), after
 * an optional [icon] 8 before it (a provider's mark); a hairline 8 above
 * every group after the first.
 */
@Composable
fun PickerSheetSection(key: String, title: String?, separated: Boolean, icon: (@Composable () -> Unit)? = null) {
    val colors = HappyTheme.colors
    if (separated) {
        Box(
            Modifier
                .padding(horizontal = PickerSheetSpec.rowInset)
                .padding(top = 8.dp)
                .fillMaxWidth()
                .heightIn(min = hairline(), max = hairline())
                .background(colors.divider),
        )
    }
    if (title != null) {
        Row(
            modifier = Modifier
                .testTag(PickerSheetTags.section(key))
                .padding(start = PickerSheetSpec.rowInset, end = PickerSheetSpec.rowInset, top = 12.dp, bottom = 4.dp)
                .semantics { heading() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            icon?.invoke()
            Text(
                title,
                style = PickerSheetSpec.sectionTitle,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
    }
}

/**
 * PickerSheetOption: the whole row (at least 56, 24 in, 8 vertical) is the
 * target. A 20 radio (2 border, a 10 dot when chosen) or, for an action, a
 * 20 add glyph; 16 on, the 16 label (after an optional 14 secondary
 * [labelIcon], 6 apart) and an optional 13 second line. Disabled rows are
 * drawn at 45%.
 */
@Composable
fun PickerSheetOption(
    key: String,
    label: String,
    description: String?,
    selected: Boolean,
    onClick: () -> Unit,
    disabled: Boolean = false,
    action: Boolean = false,
    labelIcon: Ionicon? = null,
) {
    val colors = HappyTheme.colors
    val chat = ChatTheme.colors
    Row(
        modifier = Modifier
            .testTag(PickerSheetTags.option(key))
            .fillMaxWidth()
            .heightIn(min = PickerSheetSpec.optionMinHeight)
            .clickable(enabled = !disabled, role = if (action) Role.Button else Role.RadioButton, onClick = onClick)
            .then(if (disabled) Modifier.alpha(0.45f) else Modifier)
            .padding(horizontal = PickerSheetSpec.rowInset, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(PickerSheetSpec.radioGap),
    ) {
        if (action) {
            Icon(Ionicon.Add, PickerSheetSpec.radio, colors.textSecondary)
        } else {
            Box(
                modifier = Modifier
                    .size(PickerSheetSpec.radio)
                    .border(2.dp, if (selected) chat.radioActive else chat.radioInactive, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                // radio.dot is radio.active in both themes.
                if (selected) Box(Modifier.size(PickerSheetSpec.radioDot).clip(CircleShape).background(chat.radioActive))
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            if (labelIcon != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(labelIcon, 14.dp, colors.textSecondary)
                    Text(label, style = PickerSheetSpec.label, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            } else {
                Text(label, style = PickerSheetSpec.label, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (description != null) {
                Text(
                    description,
                    style = PickerSheetSpec.description,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
    }
}
