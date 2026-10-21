package com.slopus.happy.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.Settings
import com.slopus.happy.ui.components.AvatarBrutalist
import com.slopus.happy.ui.components.AvatarGradient
import com.slopus.happy.ui.components.AvatarPixelated
import com.slopus.happy.ui.components.AvatarStyle
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.theme.happyTextStyle

object AppearanceTags {
    const val BUBBLE_DROPDOWN = "appearance.bubbleDropdown"
    const val BUBBLE_PREVIEW = "appearance.bubblePreview"
    const val AVATAR_DROPDOWN = "appearance.avatarDropdown"
    const val OPTION = "appearance.option"
}

/** settings/appearance.tsx stylesheet. */
object AppearanceSpec {
    val dropdownGap = 8.dp
    val dropdownMaxWidth = 184.dp
    val dropdownText = happyTextStyle(fontSize = 15)
    val dropdownChevron = 18.dp
    val dropdownPaddingVertical = 6.dp
    val optionMinHeight = 48.dp
    val optionGap = 12.dp
    val optionPaddingHorizontal = 16.dp
    val optionText = happyTextStyle(fontSize = 16)
    val optionCheck = 20.dp
    val bubbleWidth = 46.dp
    val bubbleHeight = 28.dp
    val bubbleRadius = 14.dp
    val bubbleBorder = 1.dp
    val bubblePaddingHorizontal = 9.dp
    val bubbleLineGap = 4.dp
    val bubbleLineHeight = 3.dp
    val bubbleLineWidths = listOf(18.dp, 26.dp)
    val avatarPreview = 28.dp
    const val AVATAR_PREVIEW_ID = "avatar-style-preview"
}

/** utils/userMessageBubbleColor.ts: the presets, in the picker's order. */
enum class BubbleColor(val key: String, val label: Int) {
    Gray("gray", R.string.settings_appearance_user_message_bubble_color_options_gray),
    Blue("blue", R.string.settings_appearance_user_message_bubble_color_options_blue),
    Green("green", R.string.settings_appearance_user_message_bubble_color_options_green),
    Purple("purple", R.string.settings_appearance_user_message_bubble_color_options_purple),
    Rose("rose", R.string.settings_appearance_user_message_bubble_color_options_rose),
    Sand("sand", R.string.settings_appearance_user_message_bubble_color_options_sand);

    companion object {
        /** USER_MESSAGE_BUBBLE_COLORS order. */
        val pickerOrder = listOf(Blue, Green, Purple, Rose, Sand, Gray)

        /** normalizeUserMessageBubbleColor. */
        fun normalize(value: String?): BubbleColor = entries.firstOrNull { it.key == value } ?: Gray
    }
}

/** UserMessageBubblePalette. */
data class BubblePalette(val background: Color, val border: Color, val indicator: Color)

object BubblePalettes {
    private fun hex(value: Long) = Color(0xFF000000 or value)

    private val light = mapOf(
        BubbleColor.Blue to BubblePalette(hex(0xE8F2FF), hex(0x9CC9FF), hex(0x0A84FF)),
        BubbleColor.Green to BubblePalette(hex(0xE9F7EF), hex(0x96D6AE), hex(0x34C759)),
        BubbleColor.Purple to BubblePalette(hex(0xF0EBFF), hex(0xB7A2FF), hex(0x7D68CF)),
        BubbleColor.Rose to BubblePalette(hex(0xFFF0F5), hex(0xF3A4BF), hex(0xD85D85)),
        BubbleColor.Sand to BubblePalette(hex(0xF1E7D0), hex(0xD9C292), hex(0xB28B3D)),
        BubbleColor.Gray to BubblePalette(hex(0xF0EEE6), hex(0xF0EEE6), hex(0x8E8E93)),
    )
    private val dark = mapOf(
        BubbleColor.Blue to BubblePalette(hex(0x17324D), hex(0x2F6EA8), hex(0x64B5FF)),
        BubbleColor.Green to BubblePalette(hex(0x173A27), hex(0x3D8B58), hex(0x65D385)),
        BubbleColor.Purple to BubblePalette(hex(0x2B214A), hex(0x7D68CF), hex(0xB8A8FF)),
        BubbleColor.Rose to BubblePalette(hex(0x462232), hex(0xC85E82), hex(0xFF9DBB)),
        BubbleColor.Sand to BubblePalette(hex(0x3A3326), hex(0x8D7A55), hex(0xE8C878)),
        BubbleColor.Gray to BubblePalette(hex(0x2C2C2E), hex(0x2C2C2E), hex(0x8E8E93)),
    )

    /** resolveUserMessageBubbleColor. */
    fun solid(color: BubbleColor, dark: Boolean): BubblePalette = (if (dark) this.dark else light).getValue(color)

    /**
     * resolveUserMessageBubbleGlassColor's background and border, which
     * Android's MobileGlassSurface paints as plain colours (no native
     * effect); [BubblePalette.indicator] is the glass tint, unused there.
     */
    fun glass(color: BubbleColor, dark: Boolean): BubblePalette {
        val p = solid(color, dark)
        return if (color == BubbleColor.Gray) {
            BubblePalette(
                p.background.copy(alpha = if (dark) 0.34f else 0.48f),
                Color.White.copy(alpha = if (dark) 0.18f else 0.76f),
                p.indicator.copy(alpha = if (dark) 0.08f else 0.10f),
            )
        } else {
            BubblePalette(
                p.background.copy(alpha = if (dark) 0.46f else 0.54f),
                p.border.copy(alpha = if (dark) 0.56f else 0.70f),
                p.indicator.copy(alpha = if (dark) 0.18f else 0.14f),
            )
        }
    }
}

/** BubbleColorPreview: a 46x28 pill (radius 14, 1 border, 9 side padding) with two 3-high indicator lines, 18 and 26 wide, right-aligned, 4 apart. */
@Composable
fun BubbleColorPreview(color: BubbleColor) {
    val dark = HappyTheme.colors.dark
    val palette = BubblePalettes.solid(color, dark)
    val glass = BubblePalettes.glass(color, dark)
    val shape = RoundedCornerShape(AppearanceSpec.bubbleRadius)
    Column(
        modifier = Modifier
            .size(AppearanceSpec.bubbleWidth, AppearanceSpec.bubbleHeight)
            .testTag(AppearanceTags.BUBBLE_PREVIEW)
            .clip(shape)
            .background(glass.background)
            .border(AppearanceSpec.bubbleBorder, glass.border, shape)
            .padding(horizontal = AppearanceSpec.bubblePaddingHorizontal),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(AppearanceSpec.bubbleLineGap, Alignment.CenterVertically),
    ) {
        for (width in AppearanceSpec.bubbleLineWidths) {
            Box(Modifier.size(width, AppearanceSpec.bubbleLineHeight).clip(RoundedCornerShape(50)).background(palette.indicator))
        }
    }
}

@Composable
private fun AvatarStylePreview(style: AvatarStyle, monochrome: Boolean) {
    val id = AppearanceSpec.AVATAR_PREVIEW_ID
    val size = AppearanceSpec.avatarPreview
    when (style) {
        AvatarStyle.Brutalist -> AvatarBrutalist(id, size, monochrome = monochrome)
        AvatarStyle.Pixelated -> AvatarPixelated(id, size, monochrome = monochrome)
        AvatarStyle.Gradient -> AvatarGradient(id, size, monochrome = monochrome)
    }
}

private fun avatarStyleLabel(style: AvatarStyle) = when (style) {
    AvatarStyle.Brutalist -> R.string.settings_appearance_avatar_style_options_brutalist
    AvatarStyle.Pixelated -> R.string.settings_appearance_avatar_style_options_pixelated
    AvatarStyle.Gradient -> R.string.settings_appearance_avatar_style_options_gradient
}

/** The dropdown's closed value: preview, label (15, secondary), an 18 chevron; 8 apart, at most 184 wide. */
@Composable
private fun DropdownValue(label: String, expanded: Boolean, tag: String, preview: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier.widthIn(max = AppearanceSpec.dropdownMaxWidth).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AppearanceSpec.dropdownGap),
    ) {
        preview()
        Text(
            text = label,
            style = AppearanceSpec.dropdownText,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(if (expanded) Ionicon.ChevronUp else Ionicon.ChevronDown, AppearanceSpec.dropdownChevron, colors.grouped.chevron)
    }
}

/** An option row: min 48, 16 side padding, preview, label (16), a 20 check or its space; 12 apart. Selected and pressed use the glass fills. */
@Composable
private fun DropdownOption(label: String, selected: Boolean, onClick: () -> Unit, preview: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (selected) colors.glass.backgroundSubtle else Color.Transparent)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }
            .defaultMinSize(minHeight = AppearanceSpec.optionMinHeight)
            .testTag(AppearanceTags.OPTION)
            .padding(horizontal = AppearanceSpec.optionPaddingHorizontal),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AppearanceSpec.optionGap),
    ) {
        preview()
        Text(label, style = AppearanceSpec.optionText, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (selected) Icon(Ionicon.CheckmarkCircle, AppearanceSpec.optionCheck, colors.status.connecting) else Spacer(Modifier.width(AppearanceSpec.optionCheck))
    }
}

@Composable
private fun SwitchItem(title: String, subtitle: String, icon: Ionicon, iconColor: Color, checked: Boolean, onChange: (Boolean) -> Unit) {
    Item(
        title = title,
        subtitle = subtitle,
        icon = { ItemIcon(icon, iconColor) },
        rightElement = { HappySwitch(checked = checked, onCheckedChange = onChange, label = title) },
    )
}

/**
 * Settings > Appearance (settings/appearance.tsx without its web-only rows).
 *
 * Groups: Theme (tap cycles adaptive, light, dark), Language (current
 * language, opens the picker), Chat (quota remaining; bubble colour
 * dropdown), Avatars (style dropdown with 28 previews; monochrome), Input
 * (context size), Display (session grouping, which a tap flips; compact
 * tool calls, file diffs sidebar, grouped tool calls, line numbers, harness
 * icons in the header and the list). Rows are standard [Item]s with 29 icons
 * and [HappySwitch]es; a dropdown opens under its row, 6 padding above and
 * below its options, and opening one closes the other.
 *
 * Not ported: a theme change doesn't set the platform's night mode
 * (happy-app's Appearance.setColorScheme). Compose and the system bars
 * follow the setting; only platform-drawn chrome such as the text selection
 * toolbar keeps the system's. Doing it needs UiModeManager (API 31+) plus
 * recreating the activity for its window theme, which MainActivity avoids
 * by handling uiMode itself.
 */
@Composable
fun AppearanceScreen(
    theme: ThemePreference,
    onThemeChange: (ThemePreference) -> Unit,
    onBack: () -> Unit,
    settings: Settings = Settings.Defaults,
    onSettingsChange: ((Settings) -> Settings) -> Unit = {},
    languageDetail: String = "",
    onLanguage: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    var bubbleOpen by remember { mutableStateOf(false) }
    var avatarOpen by remember { mutableStateOf(false) }
    val bubbleColor = BubbleColor.normalize(settings.userMessageBubbleColor)
    val avatarStyle = AvatarStyle.normalize(settings.avatarStyle)
    val violet = SettingsSpec.indigo

    Screen(header = { StackHeader(stringResource(R.string.settings_appearance), onBack) }) {
        ItemList {
            ItemGroup(
                title = stringResource(R.string.settings_appearance_theme),
                footer = stringResource(R.string.settings_appearance_theme_description),
            ) {
                Item(
                    title = stringResource(R.string.settings_appearance),
                    subtitle = stringResource(
                        when (theme) {
                            ThemePreference.Adaptive -> R.string.settings_appearance_theme_descriptions_adaptive
                            ThemePreference.Light -> R.string.settings_appearance_theme_descriptions_light
                            ThemePreference.Dark -> R.string.settings_appearance_theme_descriptions_dark
                        },
                    ),
                    icon = { ItemIcon(Ionicon.ContrastOutline, colors.status.connecting) },
                    detail = stringResource(
                        when (theme) {
                            ThemePreference.Adaptive -> R.string.settings_appearance_theme_options_adaptive
                            ThemePreference.Light -> R.string.settings_appearance_theme_options_light
                            ThemePreference.Dark -> R.string.settings_appearance_theme_options_dark
                        },
                    ),
                    onClick = { onThemeChange(ThemePreference.entries[(theme.ordinal + 1) % ThemePreference.entries.size]) },
                )
            }

            ItemGroup(title = stringResource(R.string.settings_language_title), footer = stringResource(R.string.settings_language_description)) {
                Item(
                    title = stringResource(R.string.settings_language_current_language),
                    icon = { ItemIcon(Ionicon.LanguageOutline, SettingsSpec.blue) },
                    detail = languageDetail,
                    onClick = onLanguage,
                )
            }

            ItemGroup(title = stringResource(R.string.settings_appearance_chat), footer = stringResource(R.string.settings_appearance_chat_description)) {
                SwitchItem(
                    stringResource(R.string.settings_appearance_usage_limit_show_remaining),
                    stringResource(R.string.settings_appearance_usage_limit_show_remaining_description),
                    Ionicon.SpeedometerOutline, colors.status.connecting,
                    settings.usageLimitShowRemaining,
                ) { value -> onSettingsChange { it.copy(usageLimitShowRemaining = value) } }
                val bubbleLabel = stringResource(bubbleColor.label)
                Item(
                    title = stringResource(R.string.settings_appearance_user_message_bubble_color),
                    subtitle = stringResource(R.string.settings_appearance_user_message_bubble_color_description),
                    icon = { ItemIcon(Ionicon.ChatbubbleEllipsesOutline, BubblePalettes.solid(bubbleColor, colors.dark).indicator) },
                    rightElement = { DropdownValue(bubbleLabel, bubbleOpen, AppearanceTags.BUBBLE_DROPDOWN) { BubbleColorPreview(bubbleColor) } },
                    onClick = {
                        avatarOpen = false
                        bubbleOpen = !bubbleOpen
                    },
                )
                if (bubbleOpen) {
                    Column(Modifier.padding(vertical = AppearanceSpec.dropdownPaddingVertical)) {
                        for (color in BubbleColor.pickerOrder) {
                            DropdownOption(stringResource(color.label), color == bubbleColor, onClick = {
                                onSettingsChange { it.copy(userMessageBubbleColor = color.key) }
                                bubbleOpen = false
                            }) { BubbleColorPreview(color) }
                        }
                    }
                }
            }

            ItemGroup(title = stringResource(R.string.settings_appearance_avatars), footer = stringResource(R.string.settings_appearance_avatars_description)) {
                val styleLabel = stringResource(avatarStyleLabel(avatarStyle))
                Item(
                    title = stringResource(R.string.settings_appearance_avatar_style),
                    icon = { ItemIcon(Ionicon.PersonCircleOutline, colors.status.connecting) },
                    rightElement = {
                        DropdownValue(styleLabel, avatarOpen, AppearanceTags.AVATAR_DROPDOWN) { AvatarStylePreview(avatarStyle, settings.avatarMonochrome) }
                    },
                    onClick = {
                        bubbleOpen = false
                        avatarOpen = !avatarOpen
                    },
                )
                if (avatarOpen) {
                    Column(Modifier.padding(vertical = AppearanceSpec.dropdownPaddingVertical)) {
                        for (style in AvatarStyle.entries) {
                            DropdownOption(stringResource(avatarStyleLabel(style)), style == avatarStyle, onClick = {
                                onSettingsChange { it.copy(avatarStyle = style.key) }
                                avatarOpen = false
                            }) { AvatarStylePreview(style, settings.avatarMonochrome) }
                        }
                    }
                }
                SwitchItem(
                    stringResource(R.string.settings_appearance_avatar_monochrome),
                    stringResource(R.string.settings_appearance_avatar_monochrome_description),
                    Ionicon.ContrastOutline, colors.status.connecting,
                    settings.avatarMonochrome,
                ) { value -> onSettingsChange { it.copy(avatarMonochrome = value) } }
            }

            ItemGroup(title = stringResource(R.string.settings_appearance_input), footer = stringResource(R.string.settings_appearance_input_description)) {
                SwitchItem(
                    stringResource(R.string.settings_appearance_always_show_context_size),
                    stringResource(R.string.settings_appearance_always_show_context_size_description),
                    Ionicon.AnalyticsOutline, violet,
                    settings.alwaysShowContextSize,
                ) { value -> onSettingsChange { it.copy(alwaysShowContextSize = value) } }
            }

            ItemGroup(title = stringResource(R.string.settings_appearance_display), footer = stringResource(R.string.settings_appearance_display_description)) {
                val project = settings.sessionListGrouping == SessionListGrouping.Project
                Item(
                    title = stringResource(R.string.sessions_filter_grouping_title),
                    icon = { ItemIcon(Ionicon.ListOutline, violet) },
                    detail = stringResource(if (project) R.string.sessions_filter_group_by_project else R.string.sessions_filter_flat_list),
                    onClick = {
                        onSettingsChange { it.copy(sessionListGrouping = if (project) SessionListGrouping.Flat else SessionListGrouping.Project) }
                    },
                )
                SwitchItem(
                    stringResource(R.string.settings_appearance_compact_tool_calls),
                    stringResource(R.string.settings_appearance_compact_tool_calls_description),
                    Ionicon.ContractOutline, violet,
                    settings.compactToolCalls,
                ) { value -> onSettingsChange { it.copy(compactToolCalls = value) } }
                SwitchItem(
                    stringResource(R.string.settings_appearance_file_diffs_sidebar),
                    stringResource(R.string.settings_appearance_file_diffs_sidebar_description),
                    Ionicon.GitBranchOutline, SettingsSpec.teal,
                    settings.fileDiffsSidebar,
                ) { value -> onSettingsChange { it.copy(fileDiffsSidebar = value) } }
                SwitchItem(
                    stringResource(R.string.settings_features_group_tool_calls),
                    stringResource(R.string.settings_features_group_tool_calls_subtitle),
                    Ionicon.LayersOutline, Color(0xFFAF52DE),
                    settings.groupToolCalls,
                ) { value -> onSettingsChange { it.copy(groupToolCalls = value) } }
                SwitchItem(
                    stringResource(R.string.settings_appearance_show_line_numbers_in_tool_views),
                    stringResource(R.string.settings_appearance_show_line_numbers_in_tool_views_description),
                    Ionicon.CodeWorkingOutline, violet,
                    settings.showLineNumbersInToolViews,
                ) { value -> onSettingsChange { it.copy(showLineNumbersInToolViews = value) } }
                SwitchItem(
                    stringResource(R.string.settings_appearance_show_harness_icon_in_session_header),
                    stringResource(R.string.settings_appearance_show_harness_icon_in_session_header_description),
                    Ionicon.AppsOutline, violet,
                    settings.showHarnessIconInSessionHeader,
                ) { value -> onSettingsChange { it.copy(showHarnessIconInSessionHeader = value) } }
                SwitchItem(
                    stringResource(R.string.settings_appearance_show_harness_icons_in_session_list),
                    stringResource(R.string.settings_appearance_show_harness_icons_in_session_list_description),
                    Ionicon.AppsOutline, violet,
                    settings.showFlavorIcons,
                ) { value -> onSettingsChange { it.copy(showFlavorIcons = value) } }
            }
        }
    }
}
