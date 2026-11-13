package com.slopus.happy.ui.gates

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.CloudCapabilities
import com.slopus.happy.onboarding.OnboardingGate
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.PluginsState
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.CloudAction
import com.slopus.happy.ui.connection.CloudAddChooser
import com.slopus.happy.ui.connection.CloudField
import com.slopus.happy.ui.connection.CloudProviderFlow
import com.slopus.happy.ui.connection.CloudSpec
import com.slopus.happy.ui.connection.CloudFrame
import com.slopus.happy.ui.connection.NotePill
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

object OnboardingStepTags {
    const val BOT_NAME = "cloudOnboarding.botName"
    fun plugin(id: String) = "cloudOnboarding.plugin.$id"
}

/** The inference gate's way to a provider: what the server offers, and opening one of its flows. */
class InferenceHost(
    val offer: suspend () -> CloudCapabilities,
    /** The person may define the team's own endpoint (providers.manage). */
    val custom: Boolean,
    /** The person's role lets them add a provider at all. */
    val allowed: Boolean,
    val open: (CloudProviderFlow) -> Unit,
)

/** The plugins gate's catalog, read as Plugins reads it, and opening a plugin's own page. */
class PluginsHost(
    val state: StateFlow<PluginsState>,
    val open: (pluginKey: String) -> Unit,
    val refresh: () -> Unit,
)

/** Runs [act] once at a time, saying [failed] where it threw. */
@Composable
private fun rememberRunner(): Runner {
    val scope = rememberCoroutineScope()
    return remember { Runner(scope) }
}

private class Runner(private val scope: kotlinx.coroutines.CoroutineScope) {
    var running by mutableStateOf<Int?>(null)
    var problem by mutableStateOf<String?>(null)

    fun run(which: Int, failed: String, act: suspend () -> Unit) {
        if (running != null) return
        running = which
        problem = null
        scope.launch {
            try {
                act()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                problem = failed
            } finally {
                running = null
            }
        }
    }
}

@Composable
private fun Problem(text: String?) {
    text?.let { Box(Modifier.testTag(CloudOnboardingTags.PROBLEM)) { NotePill(it, HappyTheme.colors.textDestructive) } }
}

/**
 * The adminBot gate: the server's own words for its admin bot (an admin
 * bot with expanded capabilities) and its name in a field, the current one
 * offered. Continue keeps the name, changed or not; Skip for now while
 * optional.
 */
@Composable
internal fun AdminBotStep(gate: OnboardingGate, bot: OnboardingGate.Kind.AdminBot, actions: OnboardingActions) {
    var name by rememberSaveable(bot.botId) { mutableStateOf(bot.name) }
    val runner = rememberRunner()
    val failed = stringResource(R.string.cloud_onboarding_bot_name_failed)
    val skipFailed = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val submit = { if (name.isNotBlank()) runner.run(0, failed) { actions.renameBot(bot, name.trim()) } }
    CloudFrame(
        title = bot.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.cloud_onboarding_bot_title),
        onBack = actions.onNotNow,
        body = bot.description?.takeIf { it.isNotBlank() } ?: stringResource(R.string.cloud_onboarding_bot_body),
        art = R.raw.state_robot,
        primary = CloudAction(stringResource(R.string.common_continue), submit, enabled = name.isNotBlank() && runner.running == null, loading = runner.running == 0),
        secondary = if (gate.requirement == OnboardingGate.Requirement.Optional) {
            CloudAction(stringResource(R.string.cloud_onboarding_skip), { runner.run(1, skipFailed) { actions.skip(gate.id) } }, enabled = runner.running == null)
        } else null,
    ) {
        CloudField(
            value = name,
            onChange = { name = it.take(80) },
            placeholder = stringResource(R.string.cloud_onboarding_bot_name),
            tag = OnboardingStepTags.BOT_NAME,
            enabled = runner.running == null,
            keyboard = KeyboardType.Text,
            ime = ImeAction.Done,
            capitalization = KeyboardCapitalization.Words,
            onIme = submit,
        )
        Problem(runner.problem)
    }
}

/**
 * The inference gate: Connect a provider opens the chooser Settings ›
 * Inference has (ChatGPT, a Claude setup token, an OpenAI, Anthropic or
 * Grok key, the team's own endpoint), each flow pushed over this one; once
 * a connection is kept the server moves the flow on. Where the free model
 * runs meanwhile the words say so.
 */
@Composable
internal fun InferenceStep(gate: OnboardingGate, inference: OnboardingGate.Kind.Inference, actions: OnboardingActions) {
    val host = actions.inference
    val runner = rememberRunner()
    var offer by remember { mutableStateOf<CloudCapabilities?>(null) }
    val optional = gate.requirement == OnboardingGate.Requirement.Optional
    val couldnt = stringResource(R.string.cloud_onboarding_couldnt_check)
    val notAllowed = stringResource(R.string.cloud_onboarding_inference_not_allowed)
    val skipFailed = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val body = stringResource(R.string.cloud_onboarding_inference_body) +
        if (inference.freeModel && optional) " " + stringResource(R.string.cloud_onboarding_inference_free) else ""
    CloudFrame(
        title = stringResource(R.string.cloud_onboarding_inference_title),
        onBack = actions.onNotNow,
        body = body,
        art = R.raw.state_llama,
        primary = CloudAction(
            stringResource(R.string.cloud_onboarding_connect_provider),
            {
                if (host == null || !host.allowed) runner.problem = notAllowed
                else runner.run(0, couldnt) { offer = host.offer() }
            },
            enabled = runner.running == null,
            loading = runner.running == 0,
        ),
        secondary = if (optional) CloudAction(stringResource(R.string.cloud_onboarding_skip), { runner.run(1, skipFailed) { actions.skip(gate.id) } }, enabled = runner.running == null) else null,
    ) {
        Problem(runner.problem)
    }
    val shown = offer
    if (shown != null && host != null) {
        CloudAddChooser(
            capabilities = shown,
            custom = host.custom,
            onPick = { flow ->
                offer = null
                host.open(flow)
            },
            onDismiss = { offer = null },
        )
    }
}

/** One row of the plugins gate: a plugin and whether it is connected. */
internal data class PluginRow(val key: String, val id: String, val name: String, val required: Boolean, val active: Boolean)

/**
 * The gate's rows: the plugins the server needs first, in its order, then
 * every other one the catalog offers; each connected as the catalog's
 * installations say, else as the gate did.
 */
internal fun pluginRows(gate: OnboardingGate.Kind.Plugins, state: PluginsState): List<PluginRow> {
    val snapshot = (state as? PluginsState.Loaded)?.snapshot
    val needed = gate.plugins.filter { it.required || it.id in gate.required }
    fun active(key: String, fallback: Boolean) =
        snapshot?.installationsOf(key)?.any { it.status == InstallationStatus.Active } ?: fallback
    val first = needed.map { p ->
        val plugin = snapshot?.plugins?.firstOrNull { it.id == p.id }
        PluginRow(plugin?.key ?: p.id, p.id, plugin?.name ?: p.name, required = true, active = active(plugin?.key ?: p.id, p.active))
    }
    val rest = snapshot?.plugins?.map { PluginRow(it.key, it.id, it.name, required = false, active = active(it.key, false)) }
        ?: gate.plugins.map { PluginRow(it.id, it.id, it.name, it.required, it.active) }
    return first + rest.filter { row -> first.none { it.id == row.id } }
}

/**
 * The plugins gate: the plugins the server needs, then the others it
 * offers, each with Set up (its own page, pushed over the flow) or
 * Connected. Read again on coming back; once the server says the gate is
 * done the flow moves on. Skip for now while optional.
 */
@Composable
internal fun PluginsStep(gate: OnboardingGate, plugins: OnboardingGate.Kind.Plugins, actions: OnboardingActions) {
    val host = actions.plugins
    val state = host?.state?.collectAsStateWithLifecycle()?.value ?: PluginsState.Loading
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { host?.refresh?.invoke() }
    val runner = rememberRunner()
    val skipFailed = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val rows = pluginRows(plugins, state)
    val waiting = rows.filter { it.required && !it.active }.map { it.name }
    CloudFrame(
        title = stringResource(R.string.cloud_onboarding_plugins_title),
        onBack = actions.onNotNow,
        body = if (waiting.isEmpty()) stringResource(R.string.cloud_onboarding_plugins_body) else stringResource(R.string.cloud_onboarding_plugins_needed, waiting.joinToString(", ")),
        art = R.raw.state_wand,
        primary = if (state == PluginsState.Failed) CloudAction(stringResource(R.string.cloud_onboarding_try_again), { host?.refresh?.invoke() }) else null,
        secondary = if (gate.requirement == OnboardingGate.Requirement.Optional) {
            CloudAction(stringResource(R.string.cloud_onboarding_skip), { runner.run(1, skipFailed) { actions.skip(gate.id) } }, enabled = runner.running == null)
        } else null,
    ) {
        if (state == PluginsState.Loading && rows.isEmpty()) {
            val text = if (HappyTheme.colors.dark) StartSpec.darkText else StartSpec.lightText
            CircularProgressIndicator(color = text, strokeWidth = 2.5.dp, modifier = Modifier.padding(8.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(CloudSpec.rowGap)) {
            for (row in rows) PluginGateRow(row, onOpen = { host?.open?.invoke(row.key) })
        }
        if (state == PluginsState.Failed) Problem(stringResource(R.string.cloud_onboarding_plugins_failed))
        Problem(runner.problem)
    }
}

@Composable
private fun PluginGateRow(row: PluginRow, onOpen: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(CloudSpec.rowRadius))
            .background(colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))
            .clickable(enabled = !row.active, role = Role.Button, onClick = onOpen)
            .padding(horizontal = CloudSpec.rowPadding, vertical = 12.dp)
            .testTag(OnboardingStepTags.plugin(row.id)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.name, style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold), color = colors.text)
            if (row.required && !row.active) {
                Text(stringResource(R.string.cloud_onboarding_required), style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
            }
        }
        if (row.active) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Ionicon.CheckmarkCircle, 18.dp, colors.textSecondary)
                Text(stringResource(R.string.cloud_onboarding_connected), style = happyTextStyle(fontSize = 15, lineHeight = 20), color = colors.textSecondary)
            }
        } else {
            Text(stringResource(R.string.cloud_onboarding_set_up), style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold), color = colors.textLink)
        }
    }
}
