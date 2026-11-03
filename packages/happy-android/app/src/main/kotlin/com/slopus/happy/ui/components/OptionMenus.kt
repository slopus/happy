package com.slopus.happy.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyColors
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object OptionMenuTags {
    const val MENU = "optionMenu"
    fun item(groupKey: String, optionKey: String) = "optionMenu.$groupKey.$optionKey"
}

/**
 * Every drop-down's look (Material 3's menu in Happy's colours): a 16
 * rounded card, white in light and the raised grey in dark with a hairline,
 * 8 of shadow, at least 200 wide. Rows are at least 48, their pressed and
 * chosen highlight a 12 rounded pill 6 in from the card's sides; text 16/22,
 * a supporting line 13/18 in the secondary colour.
 */
object MenuSpec {
    val shape = RoundedCornerShape(16.dp)
    val minWidth = 200.dp
    val maxWidth = 320.dp
    val shadow = 8.dp
    /** Below its anchor, clear of it. */
    val offset = DpOffset(0.dp, 4.dp)
    val itemInset = 6.dp
    val itemShape = RoundedCornerShape(12.dp)
    val itemPadding = PaddingValues(horizontal = 12.dp)
    val icon = 22.dp
    val check = 20.dp
    val label = happyTextStyle(fontSize = 16, lineHeight = 22)
    val supporting = happyTextStyle(fontSize = 13, lineHeight = 18)
    val sectionTitle = happyTextStyle(fontSize = 13, lineHeight = 18)

    fun container(colors: HappyColors): Color = if (colors.dark) colors.surfaceHighest else colors.surface
    fun selected(colors: HappyColors): Color = colors.text.copy(alpha = if (colors.dark) 0.08f else 0.05f)
    /** Between groups, and round the card in dark: the text colour, faint, so it shows on the lifted grey. */
    fun divider(colors: HappyColors): Color = colors.text.copy(alpha = if (colors.dark) 0.14f else 0.1f)
    fun edge(colors: HappyColors): Color = colors.text.copy(alpha = 0.1f)
}

/**
 * A drop-down from its anchor in [MenuSpec]'s look. Material's own motion:
 * it scales and fades out of the anchor's corner and back into it.
 */
@Composable
fun HappyDropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    offset: DpOffset = MenuSpec.offset,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    DropdownMenu(
        expanded = expanded && LocalPageActive.current,
        onDismissRequest = onDismissRequest,
        modifier = modifier.widthIn(min = MenuSpec.minWidth, max = MenuSpec.maxWidth),
        offset = offset,
        shape = MenuSpec.shape,
        containerColor = MenuSpec.container(colors),
        tonalElevation = 0.dp,
        shadowElevation = MenuSpec.shadow,
        border = if (colors.dark) BorderStroke(hairline(), MenuSpec.edge(colors)) else null,
        content = content,
    )
}

/**
 * One row of a [HappyDropdownMenu]: [label] with an optional [supporting]
 * line under it, a [leading] mark, and at the end [trailing] or, when
 * [selected], a check on a highlighted row. [labelLines] lets a label that
 * explains rather than names (a computer that can't be picked) wrap.
 */
@Composable
fun HappyMenuItem(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    selected: Boolean = false,
    enabled: Boolean = true,
    destructive: Boolean = false,
    labelLines: Int = 1,
) {
    val colors = HappyTheme.colors
    val ink = when {
        !enabled -> colors.textSecondary
        destructive -> colors.textDestructive
        else -> colors.text
    }
    DropdownMenuItem(
        text = {
            Column {
                Text(label, style = MenuSpec.label, color = ink, maxLines = labelLines, overflow = TextOverflow.Ellipsis)
                if (supporting != null) {
                    Text(supporting, style = MenuSpec.supporting, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                }
            }
        },
        onClick = onClick,
        modifier = modifier
            .padding(horizontal = MenuSpec.itemInset)
            .clip(MenuSpec.itemShape)
            .then(if (selected) Modifier.background(MenuSpec.selected(colors)) else Modifier)
            .semantics { this.selected = selected },
        leadingIcon = leading,
        trailingIcon = when {
            trailing != null -> trailing
            selected -> { { Icon(Ionicon.Checkmark, MenuSpec.check, colors.text) } }
            else -> null
        },
        enabled = enabled,
        colors = MenuDefaults.itemColors(
            textColor = ink,
            leadingIconColor = ink,
            trailingIconColor = ink,
            disabledTextColor = colors.textSecondary,
            disabledLeadingIconColor = colors.textSecondary,
            disabledTrailingIconColor = colors.textSecondary,
        ),
        contentPadding = MenuSpec.itemPadding,
    )
}

/** A hairline between a menu's groups, 6 above and below. */
@Composable
fun HappyMenuDivider() {
    HorizontalDivider(Modifier.padding(vertical = 6.dp), thickness = hairline(), color = MenuSpec.divider(HappyTheme.colors))
}

/** A group's title over its rows: 13/18 secondary, level with the rows' text. */
@Composable
fun HappyMenuSection(title: String, modifier: Modifier = Modifier) {
    Text(
        title,
        style = MenuSpec.sectionTitle,
        color = HappyTheme.colors.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .padding(start = MenuSpec.itemInset + 12.dp, end = MenuSpec.itemInset + 12.dp, top = 8.dp, bottom = 4.dp)
            .semantics { heading() },
    )
}

@Immutable
data class MenuOption(val key: String, val label: String, val disabled: Boolean = false, val action: Boolean = false)

/** NativeSettingsMenu's group: a labelled choice, or (no label) a plain action row. */
@Immutable
data class MenuGroup(
    val key: String,
    val label: String,
    val options: List<MenuOption>,
    val selectedKey: String?,
    val onSelect: (String) -> Unit,
)

/**
 * NativeSettingsMenu.android.tsx: the trigger opens a drop-down, one row per
 * option of every group, as "Group: Option" (no group prefix when [flat] or
 * the group has no label), the selected one checked.
 */
@Composable
fun SettingsMenu(
    groups: List<MenuGroup>,
    expanded: Boolean,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    flat: Boolean = false,
    trigger: @Composable () -> Unit,
) {
    Box(modifier = modifier) {
        trigger()
        HappyDropdownMenu(expanded = expanded, onDismissRequest = onDismiss, modifier = Modifier.testTag(OptionMenuTags.MENU)) {
            for (group in groups) {
                for (option in group.options) {
                    val prefix = if (flat || group.label.isEmpty()) "" else "${group.label}: "
                    HappyMenuItem(
                        label = prefix + option.label,
                        selected = option.key == group.selectedKey,
                        enabled = !option.disabled,
                        modifier = Modifier.testTag(OptionMenuTags.item(group.key, option.key)),
                        onClick = {
                            onDismiss()
                            group.onSelect(option.key)
                        },
                    )
                }
            }
        }
    }
}

@Immutable
data class OptionSection(val key: String, val title: String?, val options: List<MenuOption>)

/**
 * NativeOptionsPicker.android.tsx: a drop-down of sections, each under its
 * title; the selected option is checked unless it is an action.
 */
@Composable
fun OptionsPicker(
    sections: List<OptionSection>,
    selectedKey: String?,
    expanded: Boolean,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    trigger: @Composable () -> Unit,
) {
    Box(modifier = modifier) {
        trigger()
        HappyDropdownMenu(expanded = expanded, onDismissRequest = onDismiss, modifier = Modifier.testTag(OptionMenuTags.MENU)) {
            sections.forEachIndexed { index, section ->
                if (index > 0) HappyMenuDivider()
                section.title?.let { HappyMenuSection(it, Modifier.testTag(OptionMenuTags.item(section.key, "title"))) }
                for (option in section.options) {
                    HappyMenuItem(
                        label = option.label,
                        selected = !option.action && option.key == selectedKey,
                        enabled = !option.disabled,
                        modifier = Modifier.testTag(OptionMenuTags.item(section.key, option.key)),
                        onClick = {
                            onDismiss()
                            onSelect(option.key)
                        },
                    )
                }
            }
        }
    }
}
