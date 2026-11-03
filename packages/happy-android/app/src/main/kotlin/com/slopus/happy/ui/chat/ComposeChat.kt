package com.slopus.happy.ui.chat

import com.slopus.happy.text.words
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.model.BotRequest
import com.slopus.happy.model.ComposeKind
import com.slopus.happy.model.ComposeOffline
import com.slopus.happy.model.describeBotNameProblem
import com.slopus.happy.model.sanitizeBotName
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.home.BotFaceFailure
import com.slopus.happy.ui.home.BotFaceLeg
import com.slopus.happy.ui.home.HARNESS_SETUP_HELP_URL
import com.slopus.happy.ui.theme.HappyTheme
import java.util.Locale
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.PickerOption
import com.slopus.happy.model.Session
import com.slopus.happy.model.resolveStartProgress
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.attachments.ImagePicker
import com.slopus.happy.ui.attachments.attachmentNoticeAlert
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.HappyMenuSection
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.NewSessionServices
import com.slopus.happy.ui.home.StartResult
import com.slopus.happy.ui.home.pageTitle
import com.slopus.happy.ui.home.startProgressText
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

// An empty chat opened by compose, before it has a session (iOS's
// LegacyComposeStart). The screen is the chat screen itself, on a
// `compose-chat:` route id: its composer writes the account's new-session
// draft, and its first send starts the session on the draft's machine,
// folder and harness, the last ones picked, with that text and the picked
// images as the first message. The screen then becomes that session's chat
// in place, with no route change: the same screen and the same composer,
// retargeted. The computer and folder are picked in the middle of the empty
// chat, as Happy Agent's new work picks Task or Bot ([ComposeTarget]). A
// start that fails or is refused says why, and the text stays in the
// composer and the draft for another send. Leaving before it has answered
// stops it; the draft stays for the next compose. On a tablet it opens in
// the detail pane beside the sidebar, the same screen.

const val COMPOSE_CHAT_PREFIX = "compose-chat:"

fun newComposeChatId(): String = COMPOSE_CHAT_PREFIX + UUID.randomUUID().toString()

fun isComposeChatId(id: String): Boolean = id.startsWith(COMPOSE_CHAT_PREFIX)

/** A compose chat's back stack entry keeps the session its first send started under this key, for the tablet sidebar's selection. */
const val COMPOSE_STARTED = "composeChat.started"

/**
 * Compose: an empty chat. From a chat's own compose ([inPlace]) it takes
 * that chat's place, so Back still leads to what was under it (home);
 * anywhere else, the tablet sidebar's New session among them, it opens on
 * top, so Back returns to the chat that was open. An empty chat already on
 * top stays (New session pressed again).
 */
fun NavHostController.composeChat(inPlace: Boolean = false) {
    val current = currentBackStackEntry
    if (current?.destination?.hasRoute<SessionRoute>() == true) {
        if (isComposeChatId(current.toRoute<SessionRoute>().id) && current.savedStateHandle.get<String>(COMPOSE_STARTED) == null) return
        navigate(SessionRoute(newComposeChatId())) { if (inPlace) popUpTo(current.destination.id) { inclusive = true } }
    } else {
        navigate(SessionRoute(newComposeChatId()))
    }
}

object ComposeChatTags {
    const val TARGET = "composeChat.target"
    const val MACHINE_MENU = "composeChat.machineMenu"
    const val FOLDER_MENU = "composeChat.folderMenu"
    const val HARNESS_MENU = "composeChat.harnessMenu"
    fun option(page: NewSessionPage, key: String) = "composeChat.option.${page.name}.$key"
    fun kind(kind: ComposeKind) = "composeChat.kind.${kind.name}"
    const val CUSTOM_PATH = "composeChat.customPath"
}

/** The start behind a `compose-chat:` screen: the account's new-session draft and its starter. */
@Stable
class ComposeChat internal constructor(
    val routeId: String,
    internal val newSession: NewSessionServices,
    private val scope: CoroutineScope,
    private val resources: android.content.res.Resources,
    started: MutableState<String?>,
    private val retryFace: suspend (sessionId: String, seed: String) -> BotFaceFailure? = { _, _ -> null },
) {
    companion object {
        /** How long a started session's row is on its way before its absence means deleted (iOS `recordWait`). */
        const val RECORD_WAIT_MILLIS = 15_000L
    }

    /** The session the first send started; null until then. Kept through a recreation. */
    var startedId by started
        private set

    /** No session yet: the composer writes the new-session draft and Send starts one. */
    val composing: Boolean get() = startedId == null

    /** The chat the screen shows: the started session, else the route's own id (nothing stored under it). */
    val sessionId: String get() = startedId ?: routeId

    var starting by mutableStateOf(false)
        private set

    internal var alert by mutableStateOf<Alert?>(null)
    internal var notices by mutableStateOf<List<Alert>>(emptyList())
    internal var confirming by mutableStateOf<Pair<String, CompletableDeferred<Boolean>>?>(null)
    internal var prompting by mutableStateOf<Prompt?>(null)
    internal var faceRetry by mutableStateOf<FaceRetry?>(null)

    /** Why the bot's name is refused, said inside its field until it is typed into. */
    var nameProblem by mutableStateOf<String?>(null)
        internal set

    /** Bumped each time the name field should take the keyboard. */
    internal var nameFocus by mutableIntStateOf(0)

    /** The composer's text while composing: the new-session draft's, which outlives the screen. */
    val mirror: Flow<ComposerMirror> = newSession.draft.map { ComposerMirror(draft = it.input) }.distinctUntilChanged()

    /** What the composer runs as before there is a session: nothing known, so no modes, status or voice. */
    val session = ChatSessionInfo(
        Session(
            id = routeId, seq = 0, createdAt = 0, updatedAt = 0, active = false, activeAt = 0, projectId = null,
            metadata = null, metadataVersion = 0, attention = AgentAttention.None, agentStateVersion = 0,
        ),
        null,
    )

    fun writeDraft(text: String) {
        if (newSession.draft.value.input != text) newSession.setInput(text)
    }

    /**
     * The first send: the session starts with [text] and [images] as its
     * first message. Once it has, the screen is its chat; what was typed
     * while it started goes into that chat's draft through [keepDraft].
     */
    fun send(text: String, images: ImagePicker?, keepDraft: suspend (sessionId: String, text: String) -> Unit) {
        if (!composing || starting) return
        val prompt = text.trim()
        val picked = images?.images?.toList().orEmpty()
        if (prompt.isEmpty() && picked.isEmpty()) return
        newSession.setInput(prompt)
        // The folder the chat shows is where it starts, even if the computer's chats came in a moment ago.
        newSession.followMachine()
        val kind = newSession.kind.value
        val bot = newSession.bot.value
        // A bot's name is asked for where it is typed, before anything starts; the text stays.
        if (kind == ComposeKind.Bot) describeBotNameProblem(bot.name)?.let { problem -> return askName(resources.words(problem)) }
        // A computer that doesn't answer, or isn't in yet, is said so in full before anything is asked of it.
        val options = newSession.options.value
        val warning = if (options == null || options.awaitsComputers) R.string.compose_still_loading else options.offline?.let(::offlineText)
        if (warning != null) {
            alert = error(resources.getString(warning))
            return
        }
        starting = true
        scope.launch {
            try {
                val request = if (kind == ComposeKind.Bot) BotRequest(bot.name.trim(), bot.faceSeed) else null
                val result = newSession.starter.start(attachments = picked, bot = request, botMessage = true, task = kind == ComposeKind.Task) { directory ->
                    CompletableDeferred<Boolean>().also { confirming = directory to it }.await()
                }
                when (result) {
                    is StartResult.Started -> {
                        // The next compose offers a session again; a next bot a clean name and fresh faces.
                        if (request != null) newSession.botCreated(bot)
                        if (kind == ComposeKind.Task) newSession.taskCreated()
                        result.faceFailure?.let { failure -> if (request != null) faceRetry = FaceRetry(result.sessionId, request, failure) }
                        picked.forEach { images?.remove(it.id) }
                        // The starter cleared what it sent; anything left was typed since.
                        val rest = newSession.draft.value.input
                        if (rest.isNotBlank()) keepDraft(result.sessionId, rest)
                        notices = result.notices.map { attachmentNoticeAlert(it, resources) }
                        // The composer reads the session's draft from here on; only then is the next compose's emptied.
                        startedId = result.sessionId
                        if (rest.isNotBlank()) newSession.setInput("")
                    }
                    is StartResult.NotSent -> notices = result.notices.map { attachmentNoticeAlert(it, resources) }
                    is StartResult.Refused -> alert = error(resources.getString(result.refusal.text))
                    is StartResult.Failed -> alert = error(resources.words(result.message))
                    StartResult.Abandoned -> Unit
                }
            } finally {
                starting = false
            }
        }
    }

    /** The bot needs a name: the field takes the keyboard and says why, with a tick. */
    private fun askName(problem: String) {
        nameProblem = problem
        nameFocus++
    }

    /** The bot's name as typed: a pasted line break becomes a space and the daemon's ceiling is kept. */
    fun setBotName(name: String) {
        nameProblem = null
        newSession.setBotName(sanitizeBotName(name))
    }

    /** Only the face, on the bot already made; another failure offers it again. */
    internal fun retryFace(retry: FaceRetry) {
        scope.launch {
            val again = retryFace(retry.sessionId, retry.bot.faceSeed)
            faceRetry = again?.let { retry.copy(failure = it) }
        }
    }

    /** The screen went before the machine answered: the start stops; the draft stays. */
    internal fun leave() {
        if (composing && starting) newSession.starter.cancel()
    }

    @StringRes
    private fun offlineText(offline: ComposeOffline): Int = when (offline) {
        is ComposeOffline.Computer -> R.string.compose_offline_computer
        ComposeOffline.HappyAgent -> R.string.compose_offline_happy_agent
        ComposeOffline.HappyCli -> R.string.compose_offline_happy_cli
    }

    private fun error(message: String) = Alert(resources.getString(R.string.common_error), message, listOf(AlertButton(resources.getString(R.string.common_ok))))
}

/** A bot made from the empty chat that couldn't put on its face: offered again over its chat. */
internal data class FaceRetry(val sessionId: String, val bot: BotRequest, val failure: BotFaceFailure)

/** The route's [ComposeChat], or null for a route that isn't one. */
@Composable
fun rememberComposeChat(graph: AppGraph, routeId: String): ComposeChat? {
    if (!isComposeChatId(routeId)) return null
    val context = LocalContext.current
    val resources = LocalResources.current
    val services = remember(graph) { HomeServices.of(graph) }
    val newSession = remember(services, context) { services.newSession(context.applicationContext) }
    val scope = rememberCoroutineScope()
    val started = rememberSaveable(routeId) { mutableStateOf<String?>(null) }
    val compose = remember(routeId, newSession, scope, resources) {
        // A computer picked on an earlier compose holds a kept bot or task no longer: this one routes it again.
        newSession.forgetPickedMachine()
        ComposeChat(routeId, newSession, scope, resources, started) { id, seed -> services.retryBotFace(context.applicationContext, id, seed) }
    }
    DisposableEffect(compose) { onDispose { compose.leave() } }
    return compose
}

/** What a compose chat's header says under "New chat" while the start runs: "Starting Claude…" and the rest. */
@Composable
fun ComposeChat.progress(): String? {
    val phase by newSession.starter.phase.collectAsStateWithLifecycle()
    val options by newSession.options.collectAsStateWithLifecycle()
    val kind by newSession.kind.collectAsStateWithLifecycle()
    if (!starting) return null
    val step = resolveStartProgress(
        phase, options?.agent?.name.orEmpty(), options?.picksWorkspaces == true,
        createsBot = kind == ComposeKind.Bot, createsTask = kind == ComposeKind.Task,
    ) ?: return null
    return startProgressText(step)
}

/** The start's alerts and questions: an error, the images' notices, "Create Directory?", the custom path, a bot's face. */
@Composable
fun ComposeChat.Dialogs() {
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
    faceRetry?.let { retry ->
        HappyAlert(
            Alert(
                stringResource(R.string.home_dock_bot_face_failed_title),
                stringResource(
                    if (retry.failure.leg == BotFaceLeg.Uploading) R.string.home_dock_bot_face_upload_failed else R.string.home_dock_bot_face_failed,
                    retry.bot.name,
                ),
                listOf(
                    AlertButton(stringResource(R.string.home_dock_bot_not_now)),
                    AlertButton(stringResource(R.string.home_dock_bot_try_again)) { retryFace(retry) },
                ),
            ),
            onDismiss = { faceRetry = null },
        )
    }
    notices.firstOrNull()?.let { notice -> HappyAlert(notice, onDismiss = { notices = notices.drop(1) }) }
    prompting?.let { PromptModal(it, onDismiss = { prompting = null }) }
    confirming?.let { (directory, answer) ->
        // A dismissal that pressed no button is a no.
        DisposableEffect(answer) { onDispose { answer.complete(false) } }
        HappyAlert(
            Alert(
                stringResource(R.string.home_create_directory_title),
                stringResource(R.string.home_create_directory_message, directory),
                listOf(
                    AlertButton(stringResource(R.string.common_cancel)) { answer.complete(false) },
                    AlertButton(stringResource(R.string.common_create)) { answer.complete(true) },
                ),
            ),
            onDismiss = { confirming = null },
        )
    }
}

/**
 * Over the empty chat, centred between the bar and the composer as Happy
 * Agent's new work asks Task or Bot (happy-ios NewWorkPanel `.session`,
 * [NewWorkGivingWay]): what the first send makes and where it goes.
 *
 * - Session | Bot | Task always heads it, so nothing comes or goes as the
 *   computers arrive: a kind no computer's Happy Agent makes shows dimmed,
 *   and while they are still arriving every kind can be picked (500c1c485,
 *   c9adf9162). Picking Bot or Task moves the draft to a computer whose
 *   Happy Agent makes it and answers ([NewSessionServices.setKind]).
 * - The computer, always, with whether it answers in a chip on its corner
 *   ("Online", "Offline · 3d", "Happy Agent offline", "…" while arriving);
 *   its menu lists, for a bot or a task, only computers whose Happy Agent
 *   makes it, those that answer first, and leads with why the chosen one
 *   can't take the send while it can't.
 * - A session's folder and harness; a bot's name ("Name your bot", its
 *   refusal said inside the field) and what a bot is; a task asks nothing
 *   more.
 *
 * Fixed while the start runs; it fades once the session has started.
 */
@Composable
fun ComposeTarget(compose: ComposeChat, onReturn: () -> Unit = {}) {
    val newSession = compose.newSession
    val options by newSession.options.collectAsStateWithLifecycle()
    val draft by newSession.draft.collectAsStateWithLifecycle()
    val kind by newSession.kind.collectAsStateWithLifecycle()
    val bot by newSession.bot.collectAsStateWithLifecycle()
    // The folders follow the computer, while nothing has started.
    // Its chats may arrive after it: the most recent folder is looked for again as its places come in.
    LaunchedEffect(draft.selectedMachineId, draft.selectedPath, draft.selectedProjectId, options?.projects?.size) {
        if (compose.composing) newSession.followMachine()
    }
    val current = options
    val awaits = current == null || current.awaitsComputers
    var open by remember { mutableStateOf<NewSessionPage?>(null) }
    val enabled = !compose.starting
    val kinds = ComposeKind.entries
    val offered = buildSet {
        add(ComposeKind.Session)
        add(kind)
        if (current == null || !current.machinesSynced) addAll(kinds)
        if (current?.offersBots == true) add(ComposeKind.Bot)
        if (current?.offersTasks == true) add(ComposeKind.Task)
    }
    val kindLabels = listOf(
        stringResource(R.string.home_dock_kind_session),
        stringResource(R.string.new_work_bot),
        stringResource(R.string.new_work_task),
    )
    val kindLabel = stringResource(R.string.home_dock_bot_kind)

    val machineTitle = if (awaits) stringResource(R.string.compose_loading_computers) else current.machine?.name ?: stringResource(R.string.home_dock_select_machine)
    val machineStatus = composeMachineStatus(current, awaits)
    val machineRow: @Composable () -> Unit = {
        NewWorkMenuRow(
            Ionicon.DesktopOutline, machineTitle, enabled,
            onClick = { open = NewSessionPage.Machine },
            status = machineStatus,
            modifier = Modifier.testTag(NewWorkTags.MACHINE).semantics { contentDescription = listOfNotNull(machineTitle, machineStatus?.text).joinToString(", ") },
        ) {
            HappyDropdownMenu(expanded = open == NewSessionPage.Machine, onDismissRequest = { open = null }, modifier = Modifier.testTag(ComposeChatTags.MACHINE_MENU)) {
                MachineMenu(compose, current, kind, awaits) { open = null }
            }
        }
    }
    val rows = buildList<@Composable () -> Unit> {
        add(machineRow)
        when (kind) {
            ComposeKind.Session -> {
                val folder = current?.project?.name ?: "~"
                add {
                    NewWorkMenuRow(
                        Ionicon.FolderOutline, folder, enabled && current != null,
                        onClick = { open = NewSessionPage.Project },
                        modifier = Modifier.testTag(NewWorkTags.FOLDER).semantics { contentDescription = folder },
                    ) {
                        if (current != null) {
                            HappyDropdownMenu(expanded = open == NewSessionPage.Project, onDismissRequest = { open = null }, modifier = Modifier.testTag(ComposeChatTags.FOLDER_MENU)) {
                                FolderMenu(compose, current) { open = null }
                            }
                        }
                    }
                }
                add { HarnessRow(compose, current, awaits, enabled, open == NewSessionPage.Agent, onOpen = { open = NewSessionPage.Agent }, onClose = { open = null }) }
            }
            ComposeKind.Bot -> add { BotNameRow(compose, bot.name, enabled, onReturn) }
            ComposeKind.Task -> Unit
        }
    }
    NewWorkGivingWay(
        shown = compose.composing,
        kind = {
            NewWorkSegments(
                labels = kindLabels,
                selected = kinds.indexOf(kind),
                enabled = enabled,
                tag = { ComposeChatTags.kind(kinds[it]) },
                onPick = { newSession.setKind(kinds[it]) },
                segmentEnabled = { kinds[it] in offered },
                modifier = Modifier.semantics { contentDescription = kindLabel },
            )
        },
        rows = rows,
        note = if (kind == ComposeKind.Bot) {
            {
                Text(
                    stringResource(R.string.home_dock_bot_lede),
                    style = NewWorkSpec.note,
                    color = HappyTheme.colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().testTag(NewWorkTags.NOTE),
                )
            }
        } else {
            null
        },
        modifier = Modifier.testTag(ComposeChatTags.TARGET),
    )
}

/**
 * The computer row's chip (happy-ios 0c242b369): "● Online" in green,
 * "● Offline · 3d" or the daemon that doesn't answer in the warning colour,
 * "● …" in grey while the computers are still arriving; null with no
 * computer chosen.
 */
@Composable
private fun composeMachineStatus(options: NewSessionOptions?, awaits: Boolean): NewWorkStatus? {
    val colors = HappyTheme.colors
    if (awaits) return NewWorkStatus("● …", colors.textSecondary)
    if (options?.currentTarget == null) return null
    val resources = LocalResources.current
    val text = when (val offline = options.offline) {
        null -> stringResource(R.string.status_online).capitalized()
        is ComposeOffline.Computer -> stringResource(R.string.status_offline).capitalized() + " · " + compactAgo(resources, offline.lastSeenAt, System.currentTimeMillis())
        ComposeOffline.HappyAgent -> stringResource(R.string.compose_chip_happy_agent_offline)
        ComposeOffline.HappyCli -> stringResource(R.string.compose_chip_happy_cli_offline)
    }
    return NewWorkStatus("● $text", if (options.offline == null) colors.status.connected else colors.boxWarning.text)
}

private fun String.capitalized(): String = replaceFirstChar { it.titlecase(Locale.getDefault()) }

/** "now", "5m", "2h", "3d", "2w", "4mo", "1y" (happy-ios ComposeTarget.compact): never a date, which the chip has no room for. */
internal fun compactAgo(resources: android.content.res.Resources, activeAt: Long, now: Long): String {
    val minutes = (now - activeAt).coerceAtLeast(0) / 60_000
    val hours = minutes / 60
    val days = hours / 24
    return when {
        minutes < 1 -> resources.getString(R.string.compose_ago_now)
        minutes < 60 -> resources.getString(R.string.compose_ago_minutes, minutes.toInt())
        hours < 24 -> resources.getString(R.string.compose_ago_hours, hours.toInt())
        days < 7 -> resources.getString(R.string.compose_ago_days, days.toInt())
        days < 30 -> resources.getString(R.string.compose_ago_weeks, (days / 7).toInt())
        days < 365 -> resources.getString(R.string.compose_ago_months, (days / 30).toInt())
        else -> resources.getString(R.string.compose_ago_years, (days / 365).toInt())
    }
}

/**
 * The computers [kind] can go to, those that answer first, each with a
 * status dot and "online" or "last seen …"; under the menu's title, or,
 * while the chosen one can't take the send, under why.
 */
@Composable
private fun MachineMenu(compose: ComposeChat, options: NewSessionOptions?, kind: ComposeKind, awaits: Boolean, close: () -> Unit) {
    val colors = HappyTheme.colors
    val resources = LocalResources.current
    val targets = options?.targets(kind).orEmpty()
    val title = when {
        awaits && targets.isEmpty() -> null
        options?.offline != null -> stringResource(
            when (options.offline) {
                is ComposeOffline.Computer -> R.string.compose_offline_computer
                ComposeOffline.HappyAgent -> R.string.compose_offline_happy_agent
                ComposeOffline.HappyCli -> R.string.compose_offline_happy_cli
            },
        )
        else -> null
    } ?: stringResource(
        when (kind) {
            ComposeKind.Session -> R.string.home_dock_picker_machine
            ComposeKind.Bot -> R.string.compose_machines_bots
            ComposeKind.Task -> R.string.compose_machines_tasks
        },
    )
    if (options?.offline != null) {
        // The whole sentence, which a section title would cut.
        Text(
            title,
            style = MenuSpec.supporting,
            color = colors.boxWarning.text,
            modifier = Modifier.padding(horizontal = MenuSpec.itemInset + 12.dp, vertical = 8.dp).widthIn(max = 280.dp),
        )
    } else {
        HappyMenuSection(title)
    }
    if (targets.isEmpty() && awaits) {
        HappyMenuItem(label = stringResource(R.string.compose_loading_computers), onClick = {}, enabled = false)
        return
    }
    val now = System.currentTimeMillis()
    for (target in targets) {
        val online = target.isOnline(kind)
        val status = target.lastSeen(kind)?.let { resources.getString(R.string.status_last_seen, formatLastSeen(resources, it, now)) }
            ?: resources.getString(if (online) R.string.status_online else R.string.status_offline)
        HappyMenuItem(
            label = target.name,
            supporting = status,
            selected = target.id == options?.currentTarget?.id,
            leading = { StatusDot(if (online) colors.status.connected else colors.status.disconnected) },
            onClick = {
                close()
                compose.newSession.selectMachine(target.id)
            },
            modifier = Modifier.testTag(ComposeChatTags.option(NewSessionPage.Machine, target.id)),
        )
    }
}

@Composable
private fun StatusDot(color: Color) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

/** The chosen computer's folders, most recent first, and a custom path. */
@Composable
private fun FolderMenu(compose: ComposeChat, options: NewSessionOptions, close: () -> Unit) {
    val newSession = compose.newSession
    val customTitle = stringResource(R.string.machine_launcher_enter_custom_path)
    val customPlaceholder = stringResource(R.string.home_dock_custom_path_placeholder)
    val ok = stringResource(R.string.common_ok)
    HappyMenuSection(stringResource(R.string.home_dock_picker_projects))
    for (option in options.projects) {
        MenuOption(NewSessionPage.Project, option, option.key == options.project?.key) { page, key ->
            close()
            newSession.select(page, key)
        }
    }
    HappyMenuItem(
        label = customTitle,
        onClick = {
            close()
            compose.prompting = Prompt(
                title = customTitle,
                placeholder = customPlaceholder,
                defaultValue = newSession.draft.value.selectedPath ?: "~",
                confirmText = ok,
                onResult = { path -> path?.trim()?.takeIf { it.isNotEmpty() }?.let(newSession::selectPath) },
            )
        },
        modifier = Modifier.testTag(ComposeChatTags.CUSTOM_PATH),
    )
}

/**
 * The harness, a row of its own under the folder (happy-ios 01c9b0b53).
 * With nothing to run on the computer it reads Help and opens the setup
 * guide; not while the computers are still arriving, when nothing is known.
 */
@Composable
private fun HarnessRow(
    compose: ComposeChat,
    options: NewSessionOptions?,
    awaits: Boolean,
    enabled: Boolean,
    expanded: Boolean,
    onOpen: () -> Unit,
    onClose: () -> Unit,
) {
    val uriHandler = LocalUriHandler.current
    val help = options != null && !options.hasHarness && !awaits
    val title = when {
        help -> stringResource(R.string.home_dock_harness_help)
        else -> options?.agent?.name ?: compose.newSession.draft.value.agentType.displayName
    }
    val description = if (help) stringResource(R.string.home_dock_harness_help_label) else stringResource(R.string.home_dock_picker_harness) + ": " + title
    NewWorkMenuRow(
        if (help) Ionicon.HelpCircleOutline else Ionicon.HardwareChipOutline, title, enabled && options != null,
        onClick = { if (help) uriHandler.openUri(HARNESS_SETUP_HELP_URL) else onOpen() },
        modifier = Modifier.testTag(NewWorkTags.HARNESS).semantics { contentDescription = description },
    ) {
        if (options != null && !help) {
            HappyDropdownMenu(expanded = expanded, onDismissRequest = onClose, modifier = Modifier.testTag(ComposeChatTags.HARNESS_MENU)) {
                HappyMenuSection(pageTitle(NewSessionPage.Agent, options.picksWorkspaces))
                for (option in options.agents) {
                    MenuOption(NewSessionPage.Agent, option, option.key == options.agent.key) { page, key ->
                        onClose()
                        compose.newSession.select(page, key)
                    }
                }
            }
        }
    }
}

/** A bot's name: it can't go without one; a refusal is said inside the field, which takes the keyboard. */
@Composable
private fun BotNameRow(compose: ComposeChat, name: String, enabled: Boolean, onReturn: () -> Unit) {
    val focus = remember { FocusRequester() }
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(compose.nameFocus) {
        if (compose.nameFocus > 0) {
            focus.requestFocus()
            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
        }
    }
    NewWorkNameField(
        value = name,
        onValueChange = compose::setBotName,
        placeholder = stringResource(R.string.home_dock_bot_name_placeholder),
        enabled = enabled,
        onReturn = onReturn,
        problem = compose.nameProblem,
        modifier = Modifier.focusRequester(focus),
    )
}

@Composable
private fun MenuOption(page: NewSessionPage, option: PickerOption, selected: Boolean, onPick: (NewSessionPage, String) -> Unit) {
    HappyMenuItem(
        label = option.name,
        onClick = { onPick(page, option.key) },
        supporting = option.description,
        selected = selected,
        enabled = !option.disabled,
        modifier = Modifier.testTag(ComposeChatTags.option(page, option.key)),
    )
}
