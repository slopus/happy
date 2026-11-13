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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.CloudCapabilities
import com.slopus.happy.onboarding.EmailAddress
import com.slopus.happy.onboarding.OnboardingGate
import com.slopus.happy.onboarding.TeamInvite
import com.slopus.happy.onboarding.TeamInviteRefusal
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.PluginsState
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.AgentPicture
import com.slopus.happy.ui.connection.CloudAction
import com.slopus.happy.ui.connection.CloudProfileSpec
import com.slopus.happy.ui.connection.LocalAgentPictures
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
    const val BOT_POINTS = "cloudOnboarding.botPoints"
    const val INVITE_EMAIL = "cloudOnboarding.inviteEmail"
    fun plugin(id: String) = "cloudOnboarding.plugin.$id"
    fun sent(index: Int) = "cloudOnboarding.sent.$index"
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
 * The adminBot gate: its picture over the server's own words for it (an
 * admin bot with expanded capabilities), what it can do (`points`), its
 * name in a field, the current one offered, and the server's closing
 * `note` under it. Continue keeps the name, changed or not; Skip for now
 * while optional.
 */
@Composable
internal fun AdminBotStep(gate: OnboardingGate, bot: OnboardingGate.Kind.AdminBot, actions: OnboardingActions) {
    var name by rememberSaveable(bot.botId) { mutableStateOf(bot.name) }
    val runner = rememberRunner()
    val failed = stringResource(R.string.cloud_onboarding_bot_name_failed)
    val skipFailed = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val submit = { if (name.isNotBlank()) runner.run(0, failed) { actions.renameBot(bot, name.trim()) } }
    CloudFrame(
        pinActions = true,
        title = bot.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.cloud_onboarding_bot_title),
        onBack = actions.onNotNow,
        body = bot.description?.takeIf { it.isNotBlank() } ?: stringResource(R.string.cloud_onboarding_bot_body),
        art = R.raw.state_robot.takeIf { bot.picture == null },
        top = bot.picture?.let { path ->
            {
                CompositionLocalProvider(LocalAgentPictures provides actions.pictures) {
                    AgentPicture(path, bot.thumbhash, CloudProfileSpec.picture, radius = CloudProfileSpec.picture / 2)
                }
            }
        },
        primary = CloudAction(stringResource(R.string.common_continue), submit, enabled = name.isNotBlank() && runner.running == null, loading = runner.running == 0),
        secondary = if (gate.requirement == OnboardingGate.Requirement.Optional) {
            CloudAction(stringResource(R.string.cloud_onboarding_skip), { runner.run(1, skipFailed) { actions.skip(gate.id) } }, enabled = runner.running == null)
        } else null,
    ) {
        val points = bot.points.filter { it.isNotBlank() }
        if (points.isNotEmpty()) {
            val color = if (HappyTheme.colors.dark) StartSpec.darkText else StartSpec.lightText
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag(OnboardingStepTags.BOT_POINTS),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (point in points) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("•", style = happyTextStyle(fontSize = 16, lineHeight = 22), color = color)
                        Text(point, style = happyTextStyle(fontSize = 16, lineHeight = 22), color = color)
                    }
                }
            }
        }
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
        bot.note?.takeIf { it.isNotBlank() }?.let { note ->
            val color = if (HappyTheme.colors.dark) StartSpec.darkText else StartSpec.lightText
            Text(
                note,
                style = happyTextStyle(fontSize = 15, lineHeight = 20),
                color = color.copy(alpha = StartSpec.SECONDARY_ALPHA),
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
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
        pinActions = true,
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
        pinActions = true,
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

/** The teammates gate's invites, made on the server; a link goes out from the share sheet. */
class TeammatesHost(
    val invite: suspend (email: String?) -> TeamInvite,
    val share: (link: String) -> Unit,
    /** True keeps the step on screen after its gate is done, for more invites; false lets the flow move on. */
    val hold: (Boolean) -> Unit,
)

/** An invite sent from the teammates step: to [email], or a link when null. */
internal data class SentInvite(val email: String?, val invite: TeamInvite)

/**
 * The teammates gate: inviting people by email (`POST /v0/invites`), one
 * address after another, each a row under the field once sent: Sent, or
 * Share where its email didn't go out. A server that can't send email
 * makes a link instead, shared from the share sheet; one without the
 * route sends the person to the web. The first invite completes the
 * gate, but the step stays for more until Continue. Skip for now while
 * optional and nothing is sent.
 */
@Composable
internal fun TeammatesStep(gate: OnboardingGate, handle: String, actions: OnboardingActions) {
    val host = actions.teammates
    var email by rememberSaveable { mutableStateOf("") }
    val sent = remember { mutableStateListOf<SentInvite>() }
    var linksOnly by rememberSaveable { mutableStateOf(false) }
    var unsupported by rememberSaveable { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val runner = rememberRunner()
    val context = LocalContext.current
    val failed = stringResource(R.string.cloud_onboarding_invite_failed)
    val noEmail = stringResource(R.string.cloud_onboarding_no_email)
    val onWeb = stringResource(R.string.cloud_onboarding_invites_on_web)
    val skipFailed = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val address = email.trim()

    fun release() {
        host?.hold?.invoke(false)
    }

    fun send(to: String?) {
        if (host == null) return
        note = null
        runner.run(0, failed) {
            // The invite completes the gate; the step stays for more until Continue.
            host.hold(true)
            try {
                val invite = host.invite(to)
                sent += SentInvite(to, invite)
                if (to == null) invite.link?.let(host.share) else email = ""
                runCatching { actions.check() }
            } catch (e: TeamInviteRefusal.EmailNotConfigured) {
                linksOnly = true
                note = noEmail
            } catch (e: TeamInviteRefusal.Unsupported) {
                unsupported = true
                note = onWeb
            } catch (e: TeamInviteRefusal.Refused) {
                runner.problem = e.message ?: failed
            } finally {
                if (sent.isEmpty()) host.hold(false)
            }
        }
    }

    val primary = when {
        unsupported -> actions.web?.let { url -> CloudAction(stringResource(R.string.cloud_onboarding_open_web), { openUrl(context, url) }) }
        linksOnly && sent.isEmpty() -> CloudAction(stringResource(R.string.cloud_onboarding_share_invite_link), { send(null) }, enabled = runner.running == null, loading = runner.running == 0)
        linksOnly || (address.isEmpty() && sent.isNotEmpty()) -> CloudAction(stringResource(R.string.common_continue), ::release, enabled = runner.running == null)
        else -> CloudAction(
            stringResource(R.string.cloud_onboarding_send_invite),
            { send(address) },
            enabled = EmailAddress.looksValid(address) && runner.running == null,
            loading = runner.running == 0,
        )
    }
    CloudFrame(
        pinActions = true,
        title = stringResource(R.string.cloud_onboarding_teammates_title),
        onBack = actions.onNotNow,
        body = stringResource(R.string.cloud_onboarding_teammates_body, handle),
        art = R.raw.state_open_hands,
        primary = primary,
        secondary = if (gate.requirement == OnboardingGate.Requirement.Optional && sent.isEmpty()) {
            CloudAction(stringResource(R.string.cloud_onboarding_skip), { runner.run(1, skipFailed) { actions.skip(gate.id) } }, enabled = runner.running == null)
        } else null,
    ) {
        if (!linksOnly && !unsupported) {
            CloudField(
                value = email,
                onChange = {
                    email = it.take(254)
                    runner.problem = null
                },
                placeholder = stringResource(R.string.cloud_onboarding_email_placeholder),
                tag = OnboardingStepTags.INVITE_EMAIL,
                enabled = runner.running == null,
                keyboard = KeyboardType.Email,
                ime = ImeAction.Send,
                autofill = ContentType.EmailAddress,
                onIme = { if (EmailAddress.looksValid(address)) send(address) },
            )
        }
        if (sent.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(CloudSpec.rowGap)) {
                sent.forEachIndexed { index, item -> SentInviteRow(index, item, onShare = { link -> host?.share?.invoke(link) }) }
            }
        }
        note?.let { NotePill(it, null) }
        Problem(runner.problem)
    }
}

@Composable
private fun SentInviteRow(index: Int, item: SentInvite, onShare: (String) -> Unit) {
    val colors = HappyTheme.colors
    val link = item.invite.link
    // A link to share by hand: one made as a link, or an email that didn't go out.
    val shares = link != null && (item.email == null || item.invite.emailFailed)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(CloudSpec.rowRadius))
            .background(colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))
            .padding(horizontal = CloudSpec.rowPadding, vertical = 10.dp)
            .testTag(OnboardingStepTags.sent(index)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (item.email != null) {
            Avatar(item.email, 36.dp, animated = false)
        } else {
            Box(Modifier.size(36.dp).clip(CircleShape).background(colors.surfaceHigh), contentAlignment = Alignment.Center) {
                Icon(Ionicon.LinkOutline, 20.dp, colors.text)
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                item.email ?: stringResource(R.string.cloud_onboarding_invite_link),
                style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold),
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subtitle = when {
                item.email == null -> R.string.cloud_onboarding_invite_link_note
                item.invite.emailFailed -> R.string.cloud_onboarding_email_failed
                else -> R.string.cloud_onboarding_invite_sent
            }
            Text(stringResource(subtitle), style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
        }
        if (shares) {
            Text(
                stringResource(R.string.cloud_onboarding_share),
                style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold),
                color = colors.textLink,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .clickable(role = Role.Button) { onShare(link!!) }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Ionicon.CheckmarkCircle, 18.dp, colors.textSecondary)
                Text(stringResource(R.string.cloud_onboarding_sent), style = happyTextStyle(fontSize = 15, lineHeight = 20), color = colors.textSecondary)
            }
        }
    }
}

/** What came of Turn on notifications. */
enum class PushOutcome { Registered, Denied, Unsupported }

/** The mobileApp gate's push: asking Android, then registering this phone on the server. */
class NotificationsHost(
    /** Asks for notifications where they can still be asked for, then registers; throws where the server didn't take it. */
    val turnOn: suspend () -> PushOutcome,
    /** The app's notification settings. */
    val openSettings: () -> Unit,
    /** Happy on Google Play, for a build that can't get notifications. */
    val store: () -> Unit,
)

/**
 * The mobileApp gate, on the phone: the app is here already, so what the
 * server waits for is this phone's push registration. Turn on
 * notifications asks Android, then registers, and the server says the
 * gate is done. Turned off for Happy, it opens the settings, and coming
 * back registers quietly; a build without push offers Google Play's.
 * Skip for now while optional.
 */
@Composable
internal fun NotificationsStep(gate: OnboardingGate, actions: OnboardingActions) {
    val host = actions.notifications
    var next by rememberSaveable { mutableStateOf(PushOutcome.Registered) }
    var note by remember { mutableStateOf<String?>(null) }
    val runner = rememberRunner()
    val failed = stringResource(R.string.cloud_onboarding_notifications_failed)
    val off = stringResource(R.string.cloud_onboarding_notifications_off)
    val unsupported = stringResource(R.string.cloud_onboarding_notifications_unsupported)
    val skipFailed = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val primary = when (next) {
        PushOutcome.Registered -> CloudAction(
            stringResource(R.string.cloud_onboarding_turn_on_notifications),
            {
                if (host == null) {
                    next = PushOutcome.Unsupported
                    note = unsupported
                } else {
                    note = null
                    runner.run(0, failed) {
                        when (host.turnOn()) {
                            PushOutcome.Registered -> actions.check()
                            PushOutcome.Denied -> { next = PushOutcome.Denied; note = off }
                            PushOutcome.Unsupported -> { next = PushOutcome.Unsupported; note = unsupported }
                        }
                    }
                }
            },
            enabled = runner.running == null,
            loading = runner.running == 0,
        )
        PushOutcome.Denied -> CloudAction(stringResource(R.string.cloud_onboarding_open_settings), { host?.openSettings?.invoke() })
        PushOutcome.Unsupported -> CloudAction(stringResource(R.string.cloud_onboarding_update_action), { host?.store?.invoke() })
    }
    CloudFrame(
        pinActions = true,
        title = stringResource(R.string.cloud_onboarding_notifications_title),
        onBack = actions.onNotNow,
        body = stringResource(R.string.cloud_onboarding_notifications_body),
        art = R.raw.state_owl,
        primary = primary,
        secondary = if (gate.requirement == OnboardingGate.Requirement.Optional) {
            CloudAction(stringResource(R.string.cloud_onboarding_skip), { runner.run(1, skipFailed) { actions.skip(gate.id) } }, enabled = runner.running == null)
        } else null,
    ) {
        note?.let { NotePill(it, null) }
        Problem(runner.problem)
    }
}
