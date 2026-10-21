package com.slopus.happy.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.settings.Languages
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader

/**
 * Settings > Appearance > Language (settings/language.tsx): Automatic
 * (subtitle names the detected language), then every supported language by
 * its native name. Each row has the 29 language icon in blue and, when
 * selected, a 20 blue checkmark; no chevrons. Choosing another one asks to
 * restart (Cancel / OK) and only then [onSelect]s it: null for automatic.
 */
@Composable
fun LanguageScreen(
    preferredLanguage: String?,
    detectedLanguageName: String,
    onSelect: (String?) -> Unit,
    onBack: () -> Unit,
) {
    var alert by remember { mutableStateOf<Alert?>(null) }
    val current = Languages.byCode(preferredLanguage)?.code
    val title = stringResource(R.string.settings_language_needs_restart)
    val message = stringResource(R.string.settings_language_needs_restart_message)
    val cancel = stringResource(R.string.common_cancel)
    val ok = stringResource(R.string.common_ok)

    fun choose(code: String?) {
        if (code == current) return
        // Modal.confirm: only a button closes it.
        alert = Alert(title, message, listOf(AlertButton(cancel), AlertButton(ok) { onSelect(code) }), cancelable = false)
    }

    @Composable
    fun Row(code: String?, title: String, subtitle: String?) {
        Item(
            title = title,
            subtitle = subtitle,
            icon = { ItemIcon(Ionicon.LanguageOutline, SettingsSpec.blue) },
            rightElement = if (current == code) {
                { Icon(Ionicon.Checkmark, 20.dp, SettingsSpec.blue) }
            } else {
                null
            },
            onClick = { choose(code) },
            showChevron = false,
        )
    }

    Screen(header = { StackHeader(stringResource(R.string.settings_language_title), onBack) }) {
        ItemList {
            ItemGroup(title = stringResource(R.string.settings_language_current_language), footer = stringResource(R.string.settings_language_description)) {
                Row(
                    null,
                    stringResource(R.string.settings_language_automatic),
                    "${stringResource(R.string.settings_language_automatic_subtitle)} ($detectedLanguageName)",
                )
                for (language in Languages.supported) Row(language.code, language.nativeName, null)
            }
        }
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
