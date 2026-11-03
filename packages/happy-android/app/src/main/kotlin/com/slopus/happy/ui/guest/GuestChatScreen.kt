package com.slopus.happy.ui.guest

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.guest.GuestChat
import com.slopus.happy.guest.GuestChatState
import com.slopus.happy.guest.GuestLine
import com.slopus.happy.guest.GuestSender
import com.slopus.happy.guest.GuestSessionVault
import com.slopus.happy.guest.GuestStatus
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.StartedEffect
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.Serializable

/** A bot invitation's guest chat ([GuestChat]), opened from its link signed in or out. The link is a capability: it never prints. */
@Serializable data class GuestChatRoute(val url: String) {
    override fun toString() = "GuestChatRoute(…)"
}

object GuestChatTags {
    const val NAME = "guest.name"
    const val JOIN = "guest.join"
    const val MESSAGE = "guest.message"
    const val SEND = "guest.send"
    const val RETRY = "guest.retry"
    const val MORE = "guest.more"
    const val STATUS = "guest.status"
    const val TRANSCRIPT = "guest.transcript"
}

private class GuestChatHolder(vault: GuestSessionVault, url: String) : ViewModel() {
    val chat = GuestChat(vault, viewModelScope, apiOrigin = ::guestApiOrigin).also { it.open(url) }
}

/**
 * Where an invitation's bridge answers: its own origin, but in a debug
 * build `adb shell setprop debug.happy.guest_api http://127.0.0.1:<port>`
 * points it at a local bridge (iOS's DEBUG `HAPPY_GUEST_API_ORIGIN`). Never
 * from the link, and gone from release builds.
 */
internal fun guestApiOrigin(origin: String): String {
    if (!BuildConfig.DEBUG) return origin
    val value = try {
        Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, "debug.happy.guest_api") as? String
    } catch (_: Exception) {
        null
    }?.takeIf { it.isNotBlank() } ?: return origin
    val uri = try {
        java.net.URI(value)
    } catch (_: Exception) {
        return origin
    }
    val plain = uri.scheme in setOf("http", "https") && uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null &&
        uri.rawFragment == null && uri.rawPath.orEmpty().let { it.isEmpty() || it == "/" }
    return if (plain) value.trimEnd('/') else origin
}

@Composable
fun GuestChatEntry(nav: NavHostController, route: GuestChatRoute) {
    val context = LocalContext.current.applicationContext
    val chat = viewModel { GuestChatHolder(GuestSessionVault.of(context), route.url) }.chat
    StartedEffect(chat) {
        chat.setActive(true)
        try {
            kotlinx.coroutines.awaitCancellation()
        } finally {
            chat.setActive(false)
        }
    }
    val state by chat.state.collectAsStateWithLifecycle()
    GuestChatScreen(
        state = state,
        onBack = { nav.popBackStack() },
        onJoin = chat::join,
        onDraft = chat::draft,
        onSend = { chat.send(state.draft) },
        onRetry = chat::reconnect,
        onReport = chat::report,
        onLeave = chat::leave,
    )
}

/**
 * The guest chat, iOS's one screen: the bot's name, a line saying where
 * things stand, then either the name to join under (with what joining
 * means), or the chat as plain text, each line under who said it, and the
 * composer "Message as <name>". Read only hides the composer. ⋮ reports
 * the chat or leaves it.
 */
@Composable
fun GuestChatScreen(
    state: GuestChatState,
    onBack: () -> Unit,
    onJoin: (String) -> Unit,
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
    onRetry: () -> Unit,
    onReport: () -> Unit,
    onLeave: () -> Unit,
) {
    val colors = HappyTheme.colors
    var menu by remember { mutableStateOf(false) }
    Screen(
        header = {
            StackHeader(state.botName ?: stringResource(R.string.guest_title), onBack) {
                if (state.joined && !state.ended) {
                    Box {
                        androidx.compose.material3.IconButton(onClick = { menu = true }, modifier = Modifier.testTag(GuestChatTags.MORE)) {
                            Icon(Ionicon.EllipsisVertical, 24.dp, colors.text, contentDescription = stringResource(R.string.guest_more))
                        }
                        HappyDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            HappyMenuItem(stringResource(R.string.guest_report), { menu = false; onReport() })
                            HappyMenuItem(stringResource(R.string.guest_leave), { menu = false; onLeave() }, destructive = true)
                        }
                    }
                }
            }
        },
        avoidKeyboard = true,
        ground = colors.surface,
    ) {
        Column(Modifier.fillMaxSize().contentMaxWidth(LocalWindowLayout.current).padding(horizontal = GuestChatSpec.side)) {
            if (state.naming) Text(stringResource(R.string.guest_join_title), style = GuestChatSpec.title, color = colors.text, modifier = Modifier.padding(top = 8.dp))
            state.status?.let { status ->
                Text(
                    statusText(status),
                    style = GuestChatSpec.status,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 8.dp).testTag(GuestChatTags.STATUS),
                )
            }
            if (state.retry && state.joined) {
                RoundButton(stringResource(R.string.guest_reconnect), onRetry, Modifier.padding(top = 4.dp).testTag(GuestChatTags.RETRY), size = RoundButtonSize.Small, display = RoundButtonDisplay.Inverted)
            }
            when {
                state.naming -> JoinForm(state, onJoin)
                state.joined -> {
                    Transcript(state.lines, Modifier.weight(1f).padding(top = 8.dp))
                    if (!state.readOnly) Composer(state, onDraft, onSend)
                }
                else -> Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun JoinForm(state: GuestChatState, onJoin: (String) -> Unit) {
    val colors = HappyTheme.colors
    var name by remember { mutableStateOf(state.name) }
    LaunchedEffect(state.name) { if (state.name.isNotEmpty()) name = state.name }
    GuestField(
        value = name,
        onValueChange = { name = it },
        placeholder = stringResource(R.string.guest_name),
        enabled = !state.busy,
        imeAction = ImeAction.Done,
        onAction = { onJoin(name) },
        modifier = Modifier.padding(top = 24.dp).testTag(GuestChatTags.NAME),
        words = true,
    )
    RoundButton(stringResource(R.string.guest_join), { onJoin(name) }, Modifier.padding(top = 12.dp).testTag(GuestChatTags.JOIN), enabled = !state.busy, loading = state.busy)
    Text(stringResource(R.string.guest_join_notice), style = GuestChatSpec.notice, color = colors.textSecondary, modifier = Modifier.padding(top = 12.dp))
}

/** The chat as plain text, never Markdown or links: who said it, then what they said. Follows the newest line. */
@Composable
private fun Transcript(lines: List<GuestLine>, modifier: Modifier) {
    val colors = HappyTheme.colors
    val list = rememberLazyListState()
    LaunchedEffect(lines.size) { if (lines.isNotEmpty()) list.animateScrollToItem(lines.lastIndex) }
    SelectionContainer(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surfaceHigh)) {
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize().testTag(GuestChatTags.TRANSCRIPT),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(lines, key = { it.id }) { line ->
                Column {
                    Text(senderText(line.sender), style = GuestChatSpec.sender, color = colors.text)
                    Text(line.text, style = GuestChatSpec.body, color = colors.text)
                }
            }
        }
    }
}

@Composable
private fun Composer(state: GuestChatState, onDraft: (String) -> Unit, onSend: () -> Unit) {
    val enabled = !state.ended && !state.sending
    Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        GuestField(
            value = state.draft,
            onValueChange = onDraft,
            placeholder = state.displayName?.let { stringResource(R.string.guest_message_as, it) } ?: stringResource(R.string.guest_message),
            enabled = enabled && !state.pending,
            imeAction = ImeAction.Send,
            onAction = onSend,
            modifier = Modifier.weight(1f).testTag(GuestChatTags.MESSAGE),
        )
        RoundButton(
            stringResource(R.string.guest_send),
            onSend,
            Modifier.padding(start = 8.dp).size(width = 76.dp, height = 44.dp).testTag(GuestChatTags.SEND),
            size = RoundButtonSize.Normal,
            enabled = enabled,
        )
    }
}

@Composable
private fun GuestField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    imeAction: ImeAction,
    onAction: () -> Unit,
    modifier: Modifier,
    words: Boolean = false,
) {
    val colors = HappyTheme.colors
    val style = GuestChatSpec.body.copy(color = colors.input.text)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        textStyle = style,
        cursorBrush = SolidColor(colors.text),
        keyboardOptions = KeyboardOptions(
            capitalization = if (words) KeyboardCapitalization.Words else KeyboardCapitalization.Sentences,
            autoCorrectEnabled = !words,
            imeAction = imeAction,
        ),
        keyboardActions = KeyboardActions(onAny = { onAction() }),
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Box(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(colors.input.background).heightIn(min = 44.dp).padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = colors.input.placeholder), maxLines = 1)
                inner()
            }
        },
    )
}

@Composable
private fun senderText(sender: GuestSender): String = when (sender) {
    GuestSender.You -> stringResource(R.string.guest_you)
    is GuestSender.Member -> sender.name ?: stringResource(R.string.guest_member)
    is GuestSender.Bot -> sender.name
}

@Composable
internal fun statusText(status: GuestStatus): String = stringResource(
    when (status) {
        GuestStatus.Invalid -> R.string.guest_status_invalid
        GuestStatus.Opening -> R.string.guest_status_opening
        GuestStatus.OpenFailed -> R.string.guest_status_open_failed
        GuestStatus.EnterName -> R.string.guest_status_enter_name
        GuestStatus.NameInvalid -> R.string.guest_status_name_invalid
        GuestStatus.Joining -> R.string.guest_status_joining
        GuestStatus.Connecting -> R.string.guest_status_connecting
        GuestStatus.Live -> R.string.guest_status_live
        GuestStatus.BotOffline -> R.string.guest_status_bot_offline
        GuestStatus.ReadOnly -> R.string.guest_status_read_only
        GuestStatus.NotConfirmed -> R.string.guest_status_not_confirmed
        GuestStatus.ConnectionLost -> R.string.guest_status_connection_lost
        GuestStatus.Sending -> R.string.guest_status_sending
        GuestStatus.TooLong -> R.string.guest_status_too_long
        GuestStatus.LimitReached -> R.string.guest_status_limit_reached
        GuestStatus.Rejected -> R.string.guest_status_rejected
        GuestStatus.ReportSent -> R.string.guest_status_report_sent
        GuestStatus.ReportFailed -> R.string.guest_status_report_failed
        GuestStatus.InviteFull -> R.string.guest_status_invite_full
        GuestStatus.Expired -> R.string.guest_status_expired
        GuestStatus.Revoked -> R.string.guest_status_revoked
        GuestStatus.AlreadyUsed -> R.string.guest_status_already_used
        GuestStatus.Left -> R.string.guest_status_left
        GuestStatus.RemoveFailed -> R.string.guest_status_remove_failed
    },
)

/** iOS's GuestChatLayout and type: 20 from the sides, a 28 bold title, a 15 status line, 17 text, a 13 notice. */
object GuestChatSpec {
    val side = 20.dp
    val title = happyTextStyle(fontSize = 28, lineHeight = 34, weight = FontWeight.Bold)
    val status = happyTextStyle(fontSize = 15, lineHeight = 20)
    val body = happyTextStyle(fontSize = 17, lineHeight = 22)
    val sender = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold)
    val notice = happyTextStyle(fontSize = 13, lineHeight = 18)
}
