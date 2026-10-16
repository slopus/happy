package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object OptionMenuTags {
    const val MENU = "optionMenu"
    fun item(groupKey: String, optionKey: String) = "optionMenu.$groupKey.$optionKey"
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
 * NativeSettingsMenu.android.tsx: the trigger opens a Compose dropdown, one
 * row per option of every group, as "Group: ✓ Option" (the ✓ on the
 * selected one; no group prefix when [flat] or the group has no label).
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
        DropdownMenu(expanded = expanded, onDismissRequest = onDismiss, modifier = Modifier.testTag(OptionMenuTags.MENU)) {
            for (group in groups) {
                for (option in group.options) {
                    val prefix = if (flat || group.label.isEmpty()) "" else "${group.label}: "
                    val check = if (option.key == group.selectedKey) "✓ " else ""
                    MenuRow(
                        text = prefix + check + option.label,
                        enabled = !option.disabled,
                        tag = OptionMenuTags.item(group.key, option.key),
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
 * NativeOptionsPicker.android.tsx: a dropdown of sections. Compose menus
 * have no section headers, so a title is a row that cannot be chosen; the
 * selected option is prefixed with ✓ unless it is an action.
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
        DropdownMenu(expanded = expanded, onDismissRequest = onDismiss, modifier = Modifier.testTag(OptionMenuTags.MENU)) {
            for (section in sections) {
                section.title?.let { MenuRow(it, enabled = false, tag = OptionMenuTags.item(section.key, "title"), onClick = {}) }
                for (option in section.options) {
                    MenuRow(
                        text = if (!option.action && option.key == selectedKey) "✓ ${option.label}" else option.label,
                        enabled = !option.disabled,
                        tag = OptionMenuTags.item(section.key, option.key),
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

@Composable
private fun MenuRow(text: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    DropdownMenuItem(
        text = { Text(text, style = happyTextStyle(fontSize = 16, lineHeight = 24), color = if (enabled) colors.text else colors.textSecondary) },
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.testTag(tag),
    )
}
