package com.slopus.happy.ui.chat

import com.slopus.happy.text.words
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.AgentAttention
import com.slopus.happy.model.NewSessionOptions
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.PickerOption
import com.slopus.happy.model.Session
import com.slopus.happy.model.resolveStartProgress
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.attachments.ImagePicker
import com.slopus.happy.ui.attachments.attachmentNoticeAlert
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuDivider
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
    fun option(page: NewSessionPage, key: String) = "composeChat.option.${page.name}.$key"
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
) {
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

    /** The composer's text while composing: the new-session draft's, which outlives the screen. */
    val mirror: Flow<ComposerMirror> = newSession.draft.map { ComposerMirror(draft = it.input) }.distinctUntilChanged()

    /** What the composer runs as before there is a session: nothing known, so no status or voice; its modes are the draft's ([composeChatModes]). */
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

    /** A model or effort chip picked before there is a session: the draft's, which the start sends. */
    fun selectMode(field: AgentModeField, option: ModeOption) {
        val page = when (field) {
            AgentModeField.MODEL_MODE -> NewSessionPage.Model
            AgentModeField.EFFORT_LEVEL -> NewSessionPage.Effort
            AgentModeField.PERMISSION_MODE -> NewSessionPage.Permission
        }
        newSession.select(page, option.key)
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
        starting = true
        scope.launch {
            try {
                val result = newSession.starter.start(attachments = picked) { directory ->
                    CompletableDeferred<Boolean>().also { confirming = directory to it }.await()
                }
                when (result) {
                    is StartResult.Started -> {
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

    /** The screen went before the machine answered: the start stops; the draft stays. */
    internal fun leave() {
        if (composing && starting) newSession.starter.cancel()
    }

    private fun error(message: String) = Alert(resources.getString(R.string.common_error), message, listOf(AlertButton(resources.getString(R.string.common_ok))))
}

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
    val compose = remember(routeId, newSession, scope, resources) { ComposeChat(routeId, newSession, scope, resources, started) }
    DisposableEffect(compose) { onDispose { compose.leave() } }
    return compose
}

/**
 * The composer's chips before there is a session: the draft's model and
 * effort as the new-session pickers list them for its computer and
 * harness (a Happy Agent's own catalog, by provider), so what they show
 * is what the start sends. Nothing to pick until the computers are known.
 */
fun composeChatModes(options: NewSessionOptions?): ComposerModes {
    if (options == null) return ComposerModes.None
    val models = options.models.flatMap { section ->
        // HomeDock's one untitled section is a flat list, not a provider.
        val provider = section.key.takeUnless { section.title == null }
        section.options.map { ModeOption(it.key, it.name, it.description, providerId = provider, providerName = section.title, providerKind = provider) }
    }
    // A Happy Agent's levels are its bare keys.
    val efforts = options.efforts.map { ModeOption(it.key, if (it.name == it.key) ModeOptions.effortDisplayName(it.key) else it.name, it.description) }
    val permissions = options.permissions.map { ModeOption(it.key, it.name, it.description) }
    return ComposerModes(
        availableModes = permissions,
        permissionMode = permissions.find { it.key == options.permission?.key },
        availableModels = models,
        modelMode = models.find { it.key == options.model?.key },
        availableEffortLevels = efforts,
        effortLevel = efforts.find { it.key == options.effort?.key },
        canChangePermission = true,
        canChangeModel = true,
        canChangeEffort = true,
    )
}

/** What a compose chat's header says under "New chat" while the start runs: "Starting Claude…" and the rest. */
@Composable
fun ComposeChat.progress(): String? {
    val phase by newSession.starter.phase.collectAsStateWithLifecycle()
    val options by newSession.options.collectAsStateWithLifecycle()
    if (!starting) return null
    val step = resolveStartProgress(phase, options?.agent?.name.orEmpty(), options?.picksWorkspaces == true) ?: return null
    return startProgressText(step)
}

/** The start's alerts and questions: an error, the images' notices, "Create Directory?", the custom path. */
@Composable
fun ComposeChat.Dialogs() {
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
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
 * [NewWorkRoom]): where its first send goes, as rows on the name field's
 * ground. The computer (a desktop glyph), only when there is more than one,
 * then its folder (a folder glyph), each opening a menu: the computers;
 * the chosen one's folders, a custom path and, where there is a choice,
 * the harness. A computer with no folder picked starts in its most recent
 * one ([NewSessionServices.followMachine]). Fixed while the start runs; it
 * fades once the session has started.
 */
@Composable
fun ComposeTarget(compose: ComposeChat) {
    val newSession = compose.newSession
    val options by newSession.options.collectAsStateWithLifecycle()
    val draft by newSession.draft.collectAsStateWithLifecycle()
    // The folders follow the computer, while nothing has started.
    LaunchedEffect(draft.selectedMachineId, draft.selectedPath, draft.selectedProjectId, options != null) {
        if (compose.composing) newSession.followMachine()
    }
    val current = options ?: return
    var open by remember { mutableStateOf<NewSessionPage?>(null) }
    val enabled = !compose.starting
    NewWorkRoom(compose.composing) {
        Column(
            Modifier.fillMaxWidth().testTag(ComposeChatTags.TARGET),
            verticalArrangement = Arrangement.spacedBy(NewWorkSpec.rowGap),
        ) {
            if (current.machines.size > 1) {
                val machine = current.machine?.name ?: stringResource(R.string.home_dock_select_machine)
                NewWorkMenuRow(
                    Ionicon.DesktopOutline, machine, enabled,
                    onClick = { open = NewSessionPage.Machine },
                    modifier = Modifier.testTag(NewWorkTags.MACHINE).semantics { contentDescription = machine },
                ) {
                    HappyDropdownMenu(expanded = open == NewSessionPage.Machine, onDismissRequest = { open = null }, modifier = Modifier.testTag(ComposeChatTags.MACHINE_MENU)) {
                        MachineMenu(compose, current) { open = null }
                    }
                }
            }
            val folder = current.project?.name ?: "~"
            NewWorkMenuRow(
                Ionicon.FolderOutline, folder, enabled,
                onClick = { open = NewSessionPage.Project },
                modifier = Modifier.testTag(NewWorkTags.FOLDER).semantics { contentDescription = folder },
            ) {
                HappyDropdownMenu(expanded = open == NewSessionPage.Project, onDismissRequest = { open = null }, modifier = Modifier.testTag(ComposeChatTags.FOLDER_MENU)) {
                    FolderMenu(compose, current) { open = null }
                }
            }
        }
    }
}

/** The computers, in [HappyDropdownMenu]'s look: under their title, the picked one highlighted and checked. */
@Composable
private fun MachineMenu(compose: ComposeChat, options: NewSessionOptions, close: () -> Unit) {
    HappyMenuSection(pageTitle(NewSessionPage.Machine, options.picksWorkspaces))
    for (option in options.machines) {
        MenuOption(NewSessionPage.Machine, option, option.key == options.resolvedMachineId) { page, key ->
            close()
            compose.newSession.select(page, key)
        }
    }
}

/** The chosen computer's folders, most recent first, a custom path, and the harness when there is a choice of one. */
@Composable
private fun FolderMenu(compose: ComposeChat, options: NewSessionOptions, close: () -> Unit) {
    val newSession = compose.newSession
    val customTitle = stringResource(R.string.machine_launcher_enter_custom_path)
    val customPlaceholder = stringResource(R.string.home_dock_custom_path_placeholder)
    val ok = stringResource(R.string.common_ok)
    fun pick(page: NewSessionPage, key: String) {
        close()
        newSession.select(page, key)
    }
    HappyMenuSection(stringResource(R.string.home_dock_picker_projects))
    for (option in options.projects) MenuOption(NewSessionPage.Project, option, option.key == options.project?.key, ::pick)
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
    if (options.agents.size > 1) {
        HappyMenuDivider()
        HappyMenuSection(pageTitle(NewSessionPage.Agent, options.picksWorkspaces))
        for (option in options.agents) MenuOption(NewSessionPage.Agent, option, option.key == options.agent.key, ::pick)
    }
}

@Composable
private fun MenuOption(page: NewSessionPage, option: PickerOption, selected: Boolean, onPick: (NewSessionPage, String) -> Unit) {
    HappyMenuItem(
        label = option.name,
        onClick = { onPick(page, option.key) },
        supporting = option.description,
        selected = selected,
        enabled = !option.disabled,
        // A computer that can't be picked says why, in full.
        labelLines = if (option.disabled) 2 else 1,
        modifier = Modifier.testTag(ComposeChatTags.option(page, option.key)),
    )
}
