package com.slopus.happy.ui.conversation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.ProviderCli
import com.slopus.happy.agent.ProviderCliSource
import com.slopus.happy.agent.TeamRole
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.UiWork
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiCatalog
import com.slopus.happy.conversation.ui.UiOffer
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What live chat UI components draw from, beyond their props, and how
 * they act (happy-agent API.md "Chat UI", live components). Every click is
 * the component's own action through the actions route, so the
 * conversation's checks apply to it; the sources only say how things
 * stand. Null draws them as their fallback lines.
 */
@Stable
class UiLive(
    /** Sends a silent action ([com.slopus.happy.conversation.Conversation.actSilently]); its result is the widget's alone. */
    val act: (UiOffer, UiAction) -> Deferred<JsonObject?>?,
    /** An assistant's program on the computer, live; null where the server runs none. */
    val providerCli: ((String) -> StateFlow<ProviderCliSource.State>)?,
    /** A Happy Cloud team server: its components (invite, GitHub, compute) are drawn only there. */
    val team: Boolean,
    /** The team's roles, for an invite; read when an invite is drawn. */
    val roles: suspend () -> List<TeamRole>,
) {
    companion object {
        const val PROVIDER_SIGN_IN = "provider_sign_in"
        const val DEFAULT_MODEL = "default_model"
        const val INVITE = "invite"
        const val GITHUB_CONNECT = "github_connect"
        const val COMPUTE_JOIN = "compute_join"

        /** Whether [type] is drawn live on a server that is [team]. */
        fun draws(type: String, team: Boolean): Boolean = when (type) {
            PROVIDER_SIGN_IN, DEFAULT_MODEL -> true
            INVITE, GITHUB_CONNECT, COMPUTE_JOIN -> team
            else -> false
        }

        /** The product names the assistants go by before the computer says. */
        fun productName(provider: String): String = when (provider) {
            "claude" -> "Claude Code"
            "codex" -> "Codex"
            "grok" -> "Grok"
            "antigravity" -> "Antigravity"
            else -> provider
        }
    }
}

object UiLiveTags {
    const val FIGURE = "conversation.ui.live"
    const val LINE = "conversation.ui.live.line"
    const val BUTTON = "conversation.ui.live.button"
    const val SECRET_FIELD = "conversation.ui.live.secret"
    const val SECRET = "conversation.ui.live.secret.shown"
    const val SELECT = "conversation.ui.live.select"
}

/** A live figure's measures: a surfaceHigh card as the fallback's, its head, controls 8 apart, one status line. */
object UiLiveSpec {
    val gap = 8.dp
    val mark = 16.dp
    val markGap = 8.dp
    val buttonHeight = 36.dp
    val buttonPaddingH = 14.dp
    val head = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold)
    val line = happyTextStyle(fontSize = 13, lineHeight = 18)
    val button = happyTextStyle(fontSize = 14, lineHeight = 20, weight = FontWeight.Medium)
    val secret = happyTextStyle(fontSize = 15, lineHeight = 20, family = AppMono, weight = FontWeight.SemiBold)
    val command = happyTextStyle(fontSize = 12, lineHeight = 16, family = AppMono)
}

/** How one live component acts: whether it may, how its last action went, and the sending. */
private class LiveControl(
    val row: ConversationRow.Ui,
    private val live: UiLive,
    private val presses: Boolean,
    private val holds: (String) -> Boolean,
) {
    val work: UiWork get() = row.work

    /** Whether the person may send [type] now; the server decides every click. */
    fun may(type: String): Boolean = presses && !work.busy && UiCatalog.allowed(type, row.component.props, holds)

    /** Whether the person's role allows [type] at all. */
    fun allowed(type: String): Boolean = UiCatalog.allowed(type, row.component.props, holds)

    fun send(type: String, payload: JsonObject = JsonObject(emptyMap())): Deferred<JsonObject?>? =
        if (may(type)) live.act(row.offer, UiAction(type, payload)) else null
}

/**
 * A live component ([UiLive.draws]), drawn from the server's state: one
 * AI's install and sign-in, the default model, and on a team server an
 * invite, linking GitHub, or adding a computer. A secret an action answers
 * with (an invite code, a device code, join commands) lives in the
 * widget's own memory, shown there alone, and goes when the widget does;
 * a token or code typed is masked, and gone once sent.
 */
@Composable
internal fun UiLiveRow(row: ConversationRow.Ui, live: UiLive, actions: ConversationRowActions, modifier: Modifier) {
    val presses = actions.uiPresses()
    val holds = actions.uiAllowed
    val control = LiveControl(row, live, presses, holds)
    when (row.component.type) {
        UiLive.PROVIDER_SIGN_IN -> ProviderSignIn(control, row.component.props["provider"].str.orEmpty(), live, modifier)
        UiLive.DEFAULT_MODEL -> DefaultModel(control, actions.uiCatalog(), modifier)
        UiLive.INVITE -> Invite(control, row.component.props["role"].str, live, modifier)
        UiLive.GITHUB_CONNECT -> GithubConnect(control, modifier)
        UiLive.COMPUTE_JOIN -> ComputeJoin(control, row.component.props["pool"].str, modifier)
    }
}

private const val INSTALL = "provider_sign_in.install"
private const val SIGN_IN = "provider_sign_in.sign_in"
private const val SUBMIT_CODE = "provider_sign_in.submit_code"
private const val SUBMIT_TOKEN = "provider_sign_in.submit_token"
private const val CANCEL = "provider_sign_in.cancel"

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProviderSignIn(control: LiveControl, provider: String, live: UiLive, modifier: Modifier) {
    val source = remember(live, provider) { live.providerCli?.invoke(provider) }
    val state = source?.collectAsState()?.value ?: ProviderCliSource.State.Unsupported
    val cli = (state as? ProviderCliSource.State.Read)?.cli
    val name = cli?.name ?: UiLive.productName(provider)
    val uri = LocalUriHandler.current
    val operation = cli?.operation
    val signedIn = cli?.signIn == ProviderCli.SignIn.SignedIn
    val failed = operation?.status == ProviderCli.Operation.Status.Failed && !signedIn
    val line = when {
        state is ProviderCliSource.State.Unsupported -> stringResource(R.string.ui_live_cli_unsupported)
        state is ProviderCliSource.State.Failed -> stringResource(R.string.ui_live_failed)
        cli == null -> stringResource(R.string.ui_live_cli_reading, name)
        operation?.busy == true -> operation.message ?: stringResource(R.string.ui_live_working)
        signedIn -> when {
            cli.email != null && cli.plan != null -> stringResource(R.string.ui_live_cli_signed_in_plan, cli.email, cli.plan)
            cli.email != null -> stringResource(R.string.ui_live_cli_signed_in, cli.email)
            else -> stringResource(R.string.ui_live_cli_signed_in_plain)
        }
        failed -> operation?.errorMessage ?: operation?.message ?: stringResource(R.string.ui_live_failed)
        !cli.installed && cli.installer != null -> stringResource(R.string.ui_live_cli_missing, cli.installer.sourceHost)
        !cli.installed -> stringResource(R.string.ui_live_cli_missing_no_installer, name)
        cli.signIn == ProviderCli.SignIn.SignedOut ->
            cli.installedVersion?.let { stringResource(R.string.ui_live_cli_signed_out, it) } ?: stringResource(R.string.ui_live_cli_signed_out_plain)
        else -> cli.installedVersion?.let { stringResource(R.string.ui_live_cli_unknown, it) } ?: stringResource(R.string.ui_live_cli_unknown_plain)
    }
    LiveFigure(
        title = name,
        line = line,
        work = control.work,
        error = failed || state is ProviderCliSource.State.Failed,
        busy = cli == null && state is ProviderCliSource.State.Reading || operation?.busy == true,
        modifier = modifier,
    ) {
        if (cli == null) return@LiveFigure
        when {
            operation?.busy == true -> {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(UiLiveSpec.gap), verticalArrangement = Arrangement.spacedBy(UiLiveSpec.gap)) {
                    operation.userCode?.let { Text(stringResource(R.string.ui_live_cli_code, it), style = UiLiveSpec.secret, color = HappyTheme.colors.text, modifier = Modifier.align(Alignment.CenterVertically)) }
                    operation.url?.let { url -> LiveButton(stringResource(R.string.ui_live_cli_open_page), enabled = true, primary = true) { uri.openUri(url) } }
                    LiveButton(stringResource(R.string.ui_live_cli_cancel), enabled = control.may(CANCEL)) { control.send(CANCEL) }
                }
                if (operation.acceptsCode && control.allowed(SUBMIT_CODE)) {
                    SecretField(stringResource(R.string.ui_live_cli_code_field), stringResource(R.string.ui_live_send), control.may(SUBMIT_CODE)) { code ->
                        control.send(SUBMIT_CODE, buildJsonObject { put("code", code) })
                    }
                }
            }
            signedIn -> LiveButton(stringResource(R.string.ui_live_cli_use, name), enabled = control.may(SIGN_IN), primary = true) { control.send(SIGN_IN) }
            failed -> {
                val retry = if (!cli.installed && cli.installer != null) INSTALL else SIGN_IN
                LiveButton(stringResource(R.string.ui_live_try_again), enabled = control.may(retry), primary = true) { control.send(retry) }
            }
            else -> {
                if (!cli.installed) {
                    cli.installer?.let { installer ->
                        Text(installer.command, style = UiLiveSpec.command, color = HappyTheme.colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        LiveButton(stringResource(R.string.ui_live_cli_install), enabled = control.may(INSTALL), primary = true) { control.send(INSTALL) }
                    }
                } else {
                    LiveButton(stringResource(R.string.ui_live_cli_sign_in), enabled = control.may(SIGN_IN), primary = true) { control.send(SIGN_IN) }
                }
                if (control.allowed(SUBMIT_TOKEN)) {
                    SecretField(stringResource(R.string.ui_live_cli_token), stringResource(R.string.ui_live_send), control.may(SUBMIT_TOKEN)) { token ->
                        control.send(SUBMIT_TOKEN, buildJsonObject { put("token", token) })
                    }
                }
            }
        }
    }
}

private const val SET_MODEL = "default_model.set"

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DefaultModel(control: LiveControl, catalog: ModeCatalog?, modifier: Modifier) {
    val sending = control.work.sending?.payload
    val providerId = sending?.get("providerId").str ?: catalog?.defaults?.providerId
    val modelId = sending?.get("modelId").str ?: catalog?.defaults?.modelId
    val effort = sending?.get("effort").str ?: catalog?.defaults?.effort
    val current = catalog?.models?.firstOrNull { it.providerId == providerId && it.modelId == modelId }
    val allowed = control.allowed(SET_MODEL)
    val line = when {
        catalog == null -> stringResource(R.string.ui_live_model_reading)
        control.work.busy -> stringResource(R.string.ui_live_model_saving)
        !allowed -> stringResource(R.string.ui_live_not_allowed)
        else -> stringResource(R.string.ui_live_model_line)
    }
    LiveFigure(stringResource(R.string.ui_live_model_title), line, control.work, busy = catalog == null, modifier = modifier) {
        if (catalog == null) return@LiveFigure
        val enabled = control.may(SET_MODEL)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(UiLiveSpec.gap), verticalArrangement = Arrangement.spacedBy(UiLiveSpec.gap)) {
            LiveSelect(
                current?.name ?: modelId.orEmpty(),
                catalog.models.map { it.name to "${it.providerId}\n${it.modelId}" },
                current?.let { "${it.providerId}\n${it.modelId}" },
                enabled,
                supporting = catalog.models.map { it.providerName },
            ) { picked ->
                val choice = catalog.models.firstOrNull { "${it.providerId}\n${it.modelId}" == picked } ?: return@LiveSelect
                val next = effort?.takeIf { it in choice.efforts } ?: choice.defaultEffort ?: choice.efforts.firstOrNull() ?: return@LiveSelect
                control.send(SET_MODEL, selection(choice.providerId, choice.modelId, next))
            }
            if (current != null && current.efforts.isNotEmpty()) {
                LiveSelect(
                    effort?.let(ModeOptions::effortDisplayName).orEmpty(),
                    current.efforts.map { ModeOptions.effortDisplayName(it) to it },
                    effort,
                    enabled,
                ) { picked -> control.send(SET_MODEL, selection(current.providerId, current.modelId, picked)) }
            }
        }
    }
}

private fun selection(providerId: String, modelId: String, effort: String) = buildJsonObject {
    put("providerId", providerId)
    put("modelId", modelId)
    put("effort", effort)
}

private const val CREATE_INVITE = "invite.create"

/** An invite code just made, the widget's alone. */
private class Created(val code: String, val roleId: String, val serverName: String?)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Invite(control: LiveControl, role: String?, live: UiLive, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    val roles by produceState<List<TeamRole>?>(null, live) {
        value = try {
            live.roles()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }
    var created by remember { mutableStateOf<Created?>(null) }
    var picked by remember { mutableStateOf<String?>(null) }
    DisposableEffect(Unit) { onDispose { created = null } }
    // An owner is made by an owner alone; the phone offers the rest, as the server lists them.
    val offered = roles.orEmpty().filter { it.id != "owner" }
    val roleId = listOfNotNull(picked, role, "member").firstOrNull { id -> offered.any { it.id == id } } ?: offered.firstOrNull()?.id
    val roleName = offered.firstOrNull { it.id == roleId }?.name ?: roleId.orEmpty()
    val manage = control.allowed(CREATE_INVITE)
    val shown = created
    val line = when {
        roles == null -> stringResource(R.string.ui_live_invite_reading)
        !manage -> stringResource(R.string.ui_live_invite_not_allowed)
        shown != null -> {
            val name = offered.firstOrNull { it.id == shown.roleId }?.name ?: shown.roleId
            shown.serverName?.let { stringResource(R.string.ui_live_invite_created_server, it, name) } ?: stringResource(R.string.ui_live_invite_created, name)
        }
        else -> stringResource(R.string.ui_live_invite_line, roleName)
    }
    LiveFigure(stringResource(R.string.ui_live_invite_title), line, control.work, busy = roles == null, modifier = modifier) {
        if (shown != null) {
            SecretShown(shown.code)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(UiLiveSpec.gap)) {
                CopyButton(shown.code)
                LiveButton(stringResource(R.string.ui_live_invite_again), enabled = true) { created = null }
            }
        } else if (manage && roles != null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(UiLiveSpec.gap), verticalArrangement = Arrangement.spacedBy(UiLiveSpec.gap)) {
                LiveSelect(roleName, offered.map { it.name to it.id }, roleId, enabled = control.may(CREATE_INVITE)) { picked = it }
                LiveButton(stringResource(R.string.ui_live_invite_create), enabled = roleId != null && control.may(CREATE_INVITE), primary = true) {
                    val id = roleId ?: return@LiveButton
                    val answer = control.send(CREATE_INVITE, buildJsonObject { put("role", id) }) ?: return@LiveButton
                    scope.launch {
                        val result = answer.await() ?: return@launch
                        val code = result["code"].str ?: return@launch
                        created = Created(code, id, result["serverName"].str)
                    }
                }
            }
        }
    }
}

private const val DEVICE_START = "github_connect.device_start"

/** A GitHub device code just made, the widget's alone. */
private class DeviceCode(val userCode: String, val uri: String)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GithubConnect(control: LiveControl, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var device by remember { mutableStateOf<DeviceCode?>(null) }
    DisposableEffect(Unit) { onDispose { device = null } }
    val shown = device
    val line = when {
        shown != null -> stringResource(R.string.ui_live_github_code)
        control.allowed(DEVICE_START) -> stringResource(R.string.ui_live_github_line)
        else -> stringResource(R.string.ui_live_github_not_allowed)
    }
    LiveFigure(stringResource(R.string.ui_live_github_title), line, control.work, modifier = modifier) {
        if (shown != null) {
            SecretShown(shown.userCode)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(UiLiveSpec.gap)) {
                CopyButton(shown.userCode)
                LiveButton(stringResource(R.string.ui_live_github_open), enabled = true, primary = true) { uri.openUri(shown.uri) }
            }
        } else {
            LiveButton(stringResource(R.string.ui_live_github_link), enabled = control.may(DEVICE_START), primary = true) {
                val answer = control.send(DEVICE_START) ?: return@LiveButton
                scope.launch {
                    val result = answer.await() ?: return@launch
                    device = DeviceCode(result["userCode"].str ?: return@launch, result["verificationUri"].str ?: return@launch)
                }
            }
        }
    }
}

private const val JOIN_CREATE = "compute_join.create"

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ComputeJoin(control: LiveControl, pool: String?, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    var commands by remember { mutableStateOf<List<String>?>(null) }
    DisposableEffect(Unit) { onDispose { commands = null } }
    val shown = commands
    val line = when {
        shown != null -> stringResource(R.string.ui_live_compute_shown)
        !control.allowed(JOIN_CREATE) -> stringResource(R.string.ui_live_compute_not_allowed)
        pool != null -> stringResource(R.string.ui_live_compute_line_pool, pool)
        else -> stringResource(R.string.ui_live_compute_line)
    }
    LiveFigure(stringResource(R.string.ui_live_compute_title), line, control.work, modifier = modifier) {
        if (shown != null) {
            Text(
                shown.first(),
                style = UiLiveSpec.command,
                color = HappyTheme.colors.text,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag(UiLiveTags.SECRET),
            )
            CopyButton(shown.joinToString("\n"))
        } else {
            LiveButton(stringResource(R.string.ui_live_compute_make), enabled = control.may(JOIN_CREATE), primary = true) {
                val answer = control.send(JOIN_CREATE) ?: return@LiveButton
                scope.launch {
                    val list = answer.await()?.get("commands").arr?.mapNotNull { it.str }?.takeIf { it.isNotEmpty() } ?: return@launch
                    commands = list
                }
            }
        }
    }
}

/**
 * A live figure. Spec: a surfaceHigh card (radius 12, padding 12) on the
 * row's 16 inset; its head (15/20 semibold), 8, its controls 8 apart, 8,
 * one 13/18 line with a 16 mark 8 before it: a spinner while busy or
 * reading, an alert in textDestructive when the last action was refused
 * (the server's reason, else "That didn't work."), else an info mark;
 * textSecondary.
 */
@Composable
private fun LiveFigure(
    title: String,
    line: String,
    work: UiWork,
    modifier: Modifier,
    error: Boolean = false,
    busy: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = HappyTheme.colors
    val refused = work.refused && !work.busy
    val failed = refused || error
    val shownLine = if (refused) work.reason?.takeIf { it.isNotBlank() } ?: stringResource(R.string.ui_live_failed) else line
    Column(
        modifier
            .background(colors.surfaceHigh, RoundedCornerShape(ConversationRowSpec.cardRadius))
            .padding(ConversationRowSpec.cardPadding),
        verticalArrangement = Arrangement.spacedBy(UiLiveSpec.gap),
    ) {
        Text(title, style = UiLiveSpec.head, color = colors.text)
        content()
        Row(Modifier.testTag(UiLiveTags.LINE), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(UiLiveSpec.mark).padding(top = 1.dp), contentAlignment = Alignment.Center) {
                when {
                    failed -> Icon(Ionicon.AlertCircleOutline, UiLiveSpec.mark, colors.textDestructive)
                    busy || work.busy -> CircularProgressIndicator(Modifier.size(14.dp), color = colors.textSecondary, strokeWidth = 1.5.dp)
                    else -> Icon(Ionicon.InformationCircleOutline, UiLiveSpec.mark, colors.textSecondary)
                }
            }
            Spacer(Modifier.width(UiLiveSpec.markGap))
            Text(shownLine, style = UiLiveSpec.line, color = if (failed) colors.textDestructive else colors.textSecondary)
        }
    }
}

/** A 36 high pill: primary in the primary button's colours, else surface with a hairline; 0.48 while it can't be pressed. */
@Composable
private fun LiveButton(label: String, enabled: Boolean, primary: Boolean = false, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(UiLiveSpec.buttonHeight / 2)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Box(
        Modifier
            .testTag(UiLiveTags.BUTTON)
            .alpha(if (enabled) 1f else UiSpec.DIMMED_ALPHA)
            .heightIn(min = UiLiveSpec.buttonHeight)
            .background(if (primary) colors.button.primaryBackground else colors.surface, shape)
            .then(if (primary) Modifier else Modifier.border(hairline, colors.divider, shape))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = UiLiveSpec.buttonPaddingH),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = UiLiveSpec.button, color = if (primary) colors.button.primaryTint else colors.text, maxLines = 1)
    }
}

/** A pill showing [label] that opens a menu of [options] (label to value), [selected] checked. */
@Composable
private fun LiveSelect(
    label: String,
    options: List<Pair<String, String>>,
    selected: String?,
    enabled: Boolean,
    supporting: List<String>? = null,
    onPick: (String) -> Unit,
) {
    val colors = HappyTheme.colors
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(UiLiveSpec.buttonHeight / 2)
    val hairline = with(LocalDensity.current) { 1f.toDp() }
    Box {
        Row(
            Modifier
                .testTag(UiLiveTags.SELECT)
                .alpha(if (enabled) 1f else UiSpec.DIMMED_ALPHA)
                .heightIn(min = UiLiveSpec.buttonHeight)
                .background(colors.surface, shape)
                .border(hairline, colors.divider, shape)
                .clickable(enabled = enabled, role = Role.DropdownList) { open = true }
                .padding(horizontal = UiLiveSpec.buttonPaddingH),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = UiLiveSpec.button, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.width(6.dp))
            Icon(Ionicon.ChevronDown, 14.dp, colors.textSecondary)
        }
        HappyDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEachIndexed { i, (name, value) ->
                HappyMenuItem(name, onClick = { open = false; onPick(value) }, supporting = supporting?.getOrNull(i), selected = value == selected)
            }
        }
    }
}

/**
 * A masked field for a secret (a setup token, a sign-in code) and its Send:
 * held in this composition alone, never saved with the screen, and emptied
 * once sent.
 */
@Composable
private fun SecretField(placeholder: String, send: String, enabled: Boolean, onSend: (String) -> Unit) {
    val colors = HappyTheme.colors
    var typed by remember { mutableStateOf("") }
    DisposableEffect(Unit) { onDispose { typed = "" } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .weight(1f)
                .heightIn(min = UiSpec.fieldMinHeight)
                .background(colors.input.background, RoundedCornerShape(UiSpec.fieldRadius))
                .padding(horizontal = UiSpec.fieldPaddingH, vertical = UiSpec.fieldPaddingV),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (typed.isEmpty()) Text(placeholder, style = UiSpec.field, color = colors.input.placeholder, maxLines = 1)
            BasicTextField(
                value = typed,
                onValueChange = { typed = it.take(SECRET_MAX) },
                enabled = enabled,
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                textStyle = UiSpec.field.copy(color = colors.input.text),
                cursorBrush = SolidColor(colors.input.text),
                modifier = Modifier.fillMaxWidth().testTag(UiLiveTags.SECRET_FIELD),
            )
        }
        Spacer(Modifier.width(UiLiveSpec.gap))
        LiveButton(send, enabled = enabled && typed.isNotBlank()) {
            val value = typed.trim()
            typed = ""
            onSend(value)
        }
    }
}

/** What `submit_token` takes; a code takes less. */
private const val SECRET_MAX = 4_096

/** A secret an action answered with, in mono, selectable by its copy button alone. */
@Composable
private fun SecretShown(text: String) {
    Text(text, style = UiLiveSpec.secret, color = HappyTheme.colors.text, modifier = Modifier.testTag(UiLiveTags.SECRET))
}

@Composable
private fun CopyButton(text: String) {
    val context = LocalContext.current
    LiveButton(stringResource(R.string.ui_live_copy), enabled = true) { copySecret(context, text) }
}

/** Copies a secret, marked sensitive so the system's clipboard preview hides it. */
private fun copySecret(context: Context, text: String) {
    try {
        val clip = ClipData.newPlainText("Happy", text)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
    } catch (_: RuntimeException) {
        // A clip the system refuses; the code is still on screen.
    }
}
