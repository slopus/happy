package com.slopus.happy.ui.voice

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.ui.components.*
import com.slopus.happy.ui.home.copyToClipboard
import com.slopus.happy.ui.settings.ItemIcon
import com.slopus.happy.ui.settings.SettingsSpec
import com.slopus.happy.ui.settings.Alerts
import com.slopus.happy.ui.settings.errorAlert
import com.slopus.happy.ui.settings.rememberSupportAction
import com.slopus.happy.voice.VoiceUpsell
import com.slopus.happy.voice.VoiceUsage
import kotlinx.serialization.Serializable

@Serializable data object VoiceSettingsRoute
@Serializable data object VoiceLanguageRoute

fun NavGraphBuilder.voiceRoutes(graph: AppGraph, nav: NavHostController) {
    composable<VoiceSettingsRoute> {
        val settings by graph.settings.settings.collectAsStateWithLifecycle()
        val purchases by graph.purchases.purchases.collectAsStateWithLifecycle()
        val alerts = remember { Alerts() }
        val support = rememberSupportAction(graph.purchases, errorAlert(alerts))
        var usage by remember { mutableStateOf<VoiceUsage?>(null) }
        var loading by remember { mutableStateOf(true) }
        LaunchedEffect(graph) {
            try { usage = graph.voice.usage() } finally { loading = false }
        }
        VoiceSettingsScreen(settings, graph.settings::change, usage, loading, purchases.entitlements["pro"] == true,
            onSupport = support::run,
            onLanguage = { nav.navigate(VoiceLanguageRoute) }, onBack = { nav.popBackStack() },
            developerContent = { VoiceDeveloperSettings(graph) })
        alerts.Host()
    }
    composable<VoiceLanguageRoute> {
        val settings by graph.settings.settings.collectAsStateWithLifecycle()
        VoiceLanguageScreen(settings.voiceAssistantLanguage,
            onSelect = { code -> graph.settings.change { it.copy(voiceAssistantLanguage = code) } }, onBack = { nav.popBackStack() })
    }
}

/** settings/voice.tsx's inline Developer group; local overrides never change the account setting. */
@Composable
private fun VoiceDeveloperSettings(graph: AppGraph) {
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    if (!BuildConfig.DEBUG && !local.devModeEnabled) return
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var alert by remember { mutableStateOf<Alert?>(null) }
    var counterRevision by remember { mutableIntStateOf(0) }
    val variant = VoiceUpsell.resolve(override = local.voiceUpsellOverride, overrideEnabled = true)
    val gate = if (settings.voiceBypassToken && !settings.voiceCustomAgentId.isNullOrEmpty()) "direct BYO agent bypass" else "Happy server gate"
    fun label(v: VoiceUpsell) = when (v) {
        VoiceUpsell.Control -> "Control"
        VoiceUpsell.SoftPaywall -> "Soft paywall before first voice chat"
        VoiceUpsell.Onboarding -> "Voice onboarding and upsell"
    }
    val diagnostic = "voice-upsell: ${label(variant)}\nsource: ${if (local.voiceUpsellOverride != null) "override" else "default"}\ngate: $gate\nexperiments setting: ${if (settings.experiments) "on" else "off"}"
    val counters = remember(counterRevision) {
        "soft paywall shown: ${graph.voicePreferences.softPaywalls}\nonboarding prompt loads: ${graph.voicePreferences.onboardingLoads}\nvoice messages: ${graph.voicePreferences.messages}"
    }
    val cancel = stringResource(R.string.common_cancel)
    ItemGroup(title = "Developer", footer = "Developer-only diagnostics and local override controls for the current voice rollout. The paid voice gate runs through Happy server unless Direct Connection and a custom ElevenLabs agent are both enabled.") {
        Item(title = "Voice Experiment Override", subtitle = "Simple local override for the voice-upsell flag", detail = local.voiceUpsellOverride?.let { label(variant) } ?: "No Override",
            icon = { ItemIcon(Ionicon.OptionsOutline, SettingsSpec.blue) }, onClick = {
                alert = Alert("Voice Experiment Override", "Select a local override for the voice-upsell experiment.", buildList {
                    add(AlertButton("No Override") { graph.localSettings.change { it.copy(voiceUpsellOverride = null) } })
                    VoiceUpsell.entries.forEach { value -> add(AlertButton(label(value)) { graph.localSettings.change { it.copy(voiceUpsellOverride = value.wire) } }) }
                    add(AlertButton(cancel))
                })
            })
        Item(title = "Voice Experiment Status", subtitle = diagnostic, subtitleLines = Int.MAX_VALUE,
            icon = { ItemIcon(Ionicon.FlaskOutline, SettingsSpec.indigo) }, showChevron = false, onClick = { copyToClipboard(context, diagnostic) })
        Item(title = "Reset Voice Counters", subtitle = counters, subtitleLines = Int.MAX_VALUE,
            icon = { ItemIcon(Ionicon.RefreshOutline, SettingsSpec.orange) }, onClick = {
                alert = Alert("Reset Voice Counters", "Clear local voice counters used for onboarding and soft-paywall behavior on this device?",
                    listOf(AlertButton(cancel), AlertButton("Reset", destructive = true) { graph.voicePreferences.reset(); counterRevision++ }), cancelable = false)
            })
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}