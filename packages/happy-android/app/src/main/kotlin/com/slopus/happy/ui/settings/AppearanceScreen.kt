package com.slopus.happy.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference

/**
 * Settings > Appearance, theme section (settings/appearance.tsx). The other
 * sections configure chat, avatars and the session list, which this app
 * does not have yet. Tapping the row cycles adaptive, light, dark.
 */
@Composable
fun AppearanceScreen(
    theme: ThemePreference,
    onThemeChange: (ThemePreference) -> Unit,
    onBack: () -> Unit,
) {
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
                            ThemePreference.Adaptive -> R.string.settings_appearance_theme_description_adaptive
                            ThemePreference.Light -> R.string.settings_appearance_theme_description_light
                            ThemePreference.Dark -> R.string.settings_appearance_theme_description_dark
                        },
                    ),
                    icon = { ItemIcon(Ionicon.ContrastOutline, HappyTheme.colors.status.connecting) },
                    detail = stringResource(
                        when (theme) {
                            ThemePreference.Adaptive -> R.string.settings_appearance_theme_option_adaptive
                            ThemePreference.Light -> R.string.settings_appearance_theme_option_light
                            ThemePreference.Dark -> R.string.settings_appearance_theme_option_dark
                        },
                    ),
                    onClick = { onThemeChange(ThemePreference.entries[(theme.ordinal + 1) % ThemePreference.entries.size]) },
                )
            }
        }
    }
}
