package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.page
import com.slopus.happy.ui.settings.SettingsCard
import com.slopus.happy.ui.settings.SettingsEntry
import com.slopus.happy.ui.settings.SettingsSection
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Privacy, under both kinds of account's Settings (iOS's Privacy page). */
@Serializable data object PrivacyRoute

object PrivacyTags {
    const val ROW = "settings.privacy"
    const val ANALYTICS = "privacy.analytics"
    const val ANALYTICS_SWITCH = "privacy.analytics.switch"
}

internal fun NavGraphBuilder.privacyRoutes(graph: AppGraph, nav: NavHostController) {
    page<PrivacyRoute> { PrivacyPage(graph, nav) }
}

/** Settings' Privacy row, a card of its own. */
@Composable
fun privacySection(onPrivacy: () -> Unit) = SettingsSection(
    listOf(
        SettingsEntry(
            id = PrivacyTags.ROW,
            title = stringResource(R.string.settings_account_privacy),
            icon = { SettingsTile(Ionicon.LockClosedOutline, SettingsTiles.blue) },
            onClick = onPrivacy,
        ),
    ),
)

@Composable
private fun PrivacyPage(graph: AppGraph, nav: NavHostController) {
    val analytics by graph.analyticsSwitch.on.collectAsStateWithLifecycle()
    /** What Settings says when the switch couldn't be set: a string, or nothing. */
    var analyticsNotSaved by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    PrivacyScreen(
        analytics = analytics,
        // Off takes effect at once even when it can't be written down; then the next start would turn it on again, which Settings says.
        // On is refused while the last install id can't be deleted, or when it can't be written down: it stays off, and Settings says so.
        onAnalytics = { on ->
            scope.launch {
                if (!graph.analyticsSwitch.set(on)) analyticsNotSaved = if (on) R.string.settings_analytics_not_turned_on else R.string.settings_analytics_not_saved
            }
        },
        onBack = { nav.popBackStack() },
    )
    analyticsNotSaved?.let { message ->
        HappyAlert(
            Alert(
                title = stringResource(R.string.common_error),
                message = stringResource(message),
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { analyticsNotSaved = null },
        )
    }
}

/**
 * Privacy: this phone's Analytics switch. Off, nothing is shared from this
 * phone whatever its accounts say, and what waited to be sent is deleted.
 */
@Composable
fun PrivacyScreen(analytics: Boolean, onAnalytics: (Boolean) -> Unit, onBack: () -> Unit) {
    AgentPage(stringResource(R.string.settings_account_privacy), onBack) {
        SettingsCard(SettingsSection(
            listOf(SettingsEntry(
                id = PrivacyTags.ANALYTICS,
                title = stringResource(R.string.settings_account_analytics),
                icon = { SettingsTile(Ionicon.AnalyticsOutline, SettingsTiles.blue) },
                toggle = analytics,
                onToggle = onAnalytics,
                toggleTag = PrivacyTags.ANALYTICS_SWITCH,
                chevron = false,
            )),
            footer = stringResource(R.string.settings_account_privacy_description),
        ))
    }
}
