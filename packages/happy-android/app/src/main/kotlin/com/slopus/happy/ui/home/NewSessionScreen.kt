package com.slopus.happy.ui.home

import android.content.res.Resources
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.model.BotDraft
import com.slopus.happy.model.BotRequest
import com.slopus.happy.model.CUSTOM_PROJECT_PATH_KEY
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.isValidBotName
import com.slopus.happy.ui.attachments.attachmentNoticeAlert
import com.slopus.happy.ui.attachments.rememberImagePicker
import com.slopus.happy.ui.chat.formatLastSeen
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** new/index.tsx: the standalone new-session screen. */
@Serializable
data object NewSessionRoute

object NewSessionTags {
    const val SCREEN = "newSession"
    const val BACK = "newSession.back"
    const val TITLE = "newSession.title"
}

/** HomeDock.tsx's HARNESS_SETUP_HELP_URL: where "Help" goes when the computer runs no harness. */
const val HARNESS_SETUP_HELP_URL = "https://happy.engineering/docs/quick-start/"

/** The picker words, from the resources. */
fun newSessionLabels(resources: Resources, now: () -> Long = System::currentTimeMillis) = NewSessionLabels(
    selectMachine = resources.getString(R.string.home_dock_select_machine),
    project = resources.getString(R.string.home_dock_picker_project),
    projects = resources.getString(R.string.home_dock_picker_projects),
    noWorktree = resources.getString(R.string.home_dock_no_worktree),
    main = resources.getString(R.string.home_dock_main),
    createWorkspace = resources.getString(R.string.home_dock_create_workspace),
    createWorktree = resources.getString(R.string.home_dock_create_worktree),
    enterCustomPath = resources.getString(R.string.machine_launcher_enter_custom_path),
    online = resources.getString(R.string.status_online),
    notSupportedBy = { resources.getString(R.string.home_dock_not_supported_by, it) },
    lastSeen = { resources.getString(R.string.status_last_seen, formatLastSeen(resources, it, now())) },
)

/** A bot that was made without its face, and how to open it once the person has answered. */
private data class FaceRetry(val sessionId: String, val bot: BotDraft, val failure: BotFaceFailure, val open: () -> Unit)

/** A composer bound to the draft and the starter, with the dialogs its start may raise. */
@Immutable
class NewSessionDock(val state: HomeDockState, val actions: HomeDockActions, val dialogs: @Composable () -> Unit)

/**
 * MainView's home prompt and useStartSessionFromDraft as the screen sees
 * them: Send puts the text on the draft and starts, the picked images going
 * with the first message; a refusal or failure is an alert ("Create
 * Directory?" asks before a missing one is made); [onStarted] gets the new
 * session, by then with its first message queued. What the images ran into
 * (no image support, failed uploads) is an alert too; the new session opens
 * once it is dismissed, since this screen is gone after.
 */
@Composable
fun rememberNewSessionDock(
    graph: AppGraph,
    focused: Boolean,
    onFocusChange: (Boolean) -> Unit,
    onStarted: (sessionId: String) -> Unit,
    showScrim: Boolean = true,
    initialPrompt: () -> String = { "" },
): NewSessionDock {
    val context = LocalContext.current
    val resources = LocalResources.current
    val services = remember(graph) { HomeServices.of(graph) }
    val newSession = remember(services, context) { services.newSession(context.applicationContext) }
    val options by newSession.options.collectAsStateWithLifecycle()
    val phase by newSession.starter.phase.collectAsStateWithLifecycle()
    val botDraft by newSession.bot.collectAsStateWithLifecycle()
    val botFaces = remember(services, context) { services.botFaces(context) }
    // A bot is Happy Agent's to make, and only a daemon new enough to say so offers it.
    val supportsBots = options?.supportsBots == true
    val creatingBot = botDraft.creating && supportsBots
    val facePictures by produceState(List<BotFacePicture?>(botDraft.seeds.size) { null }, botFaces, botDraft.seeds) {
        value = botDraft.seeds.map { seed -> runCatching { botFaces.picture(seed) }.getOrNull() }
    }
    // offerBotFaceRetry: the bot is made, its face is not on yet; the bot opens once this is settled.
    var faceRetry by remember { mutableStateOf<FaceRetry?>(null) }
    val labels = remember(resources) { newSessionLabels(resources) }
    var prompt by rememberSaveable { mutableStateOf(initialPrompt()) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    // The images' alerts, one after another; the last one's dismissal may open the session.
    var notices by remember { mutableStateOf<List<Alert>>(emptyList()) }
    var afterNotices by remember { mutableStateOf<(() -> Unit)?>(null) }
    val picker = rememberImagePicker()
    var confirming by remember { mutableStateOf<Pair<String, CompletableDeferred<Boolean>>?>(null) }
    var prompting by remember { mutableStateOf<Prompt?>(null) }
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    val strings = remember(resources) {
        object {
            val error = resources.getString(R.string.common_error)
            val ok = resources.getString(R.string.common_ok)
            val customPath = resources.getString(R.string.machine_launcher_enter_custom_path)
            val customPathPlaceholder = resources.getString(R.string.home_dock_custom_path_placeholder)
        }
    }

    val actions = remember(newSession, onFocusChange, onStarted, uriHandler, strings, picker) {
        HomeDockActions(
            onPromptChange = { prompt = it },
            onFocusChange = onFocusChange,
            onSubmit = submit@{
                if (newSession.starter.phase.value != null) return@submit
                val bot = newSession.bot.value.takeIf { it.creating && newSession.options.value?.supportsBots == true }
                val text = prompt.trim()
                val images = if (bot != null) emptyList() else picker.images.toList()
                // A bot is made from its name; the prompt typed for a session is left as it was.
                if (bot == null && text.isEmpty() && images.isEmpty()) return@submit
                if (bot != null && !isValidBotName(bot.name)) return@submit
                if (bot == null) newSession.setInput(text)
                scope.launch {
                    val request = bot?.let { BotRequest(it.name.trim(), it.faceSeed) }
                    val result = newSession.starter.start(attachments = images, bot = request) { directory ->
                        CompletableDeferred<Boolean>().also { confirming = directory to it }.await()
                    }
                    when (result) {
                        is StartResult.Started -> {
                            if (bot != null) {
                                newSession.botCreated(bot)
                            } else {
                                prompt = ""
                                images.forEach { picker.remove(it.id) }
                            }
                            val open = {
                                onFocusChange(false)
                                onStarted(result.sessionId)
                            }
                            val failure = result.faceFailure
                            if (bot != null && failure != null) {
                                faceRetry = FaceRetry(result.sessionId, bot, failure, open)
                            } else if (result.notices.isEmpty()) {
                                open()
                            } else {
                                notices = result.notices.map { attachmentNoticeAlert(it, resources) }
                                afterNotices = open
                            }
                        }
                        is StartResult.NotSent -> notices = result.notices.map { attachmentNoticeAlert(it, resources) }
                        is StartResult.Refused -> alert = Alert(strings.error, result.refusal.message, listOf(AlertButton(strings.ok)))
                        is StartResult.Failed -> alert = Alert(strings.error, result.message, listOf(AlertButton(strings.ok)))
                        StartResult.Abandoned -> Unit
                    }
                }
            },
            onCancel = { newSession.starter.cancel() },
            onSelect = { page, key ->
                if (page == NewSessionPage.Project && key == CUSTOM_PROJECT_PATH_KEY) {
                    prompting = Prompt(
                        title = strings.customPath,
                        placeholder = strings.customPathPlaceholder,
                        defaultValue = newSession.draft.value.selectedPath ?: "~",
                        confirmText = strings.ok,
                        onResult = { path -> path?.trim()?.takeIf { it.isNotEmpty() }?.let(newSession::selectPath) },
                    )
                } else {
                    newSession.select(page, key)
                }
            },
            onOpenPicker = newSession::onOpenPicker,
            onHarnessHelp = { uriHandler.openUri(HARNESS_SETUP_HELP_URL) },
            onAddImage = picker::attach,
            onRemoveImage = picker::remove,
            onBotKindChange = newSession::setCreatesBot,
            onBotNameChange = newSession::setBotName,
            onBotFacePick = newSession::pickBotFace,
            onBotFacesRoll = newSession::rollBotFaces,
            onOpenUrl = { runCatching { uriHandler.openUri(it) } },
        )
    }
    val style = botFaces.loadedStyle
    val bot = if (supportsBots) {
        HomeDockBot(creatingBot, botDraft.name, facePictures, botDraft.slot, style?.artist, style?.artistUrl)
    } else {
        null
    }
    val state = HomeDockState(
        prompt, options, labels, phase, focused, showScrim,
        images = picker.images.toList(),
        canAttachImages = !creatingBot,
        bot = bot,
    )
    return NewSessionDock(state, actions) {
        alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
        notices.firstOrNull()?.let { notice ->
            HappyAlert(notice, onDismiss = {
                notices = notices.drop(1)
                if (notices.isEmpty()) afterNotices?.also { afterNotices = null }?.invoke()
            })
        }
        prompting?.let { PromptModal(it, onDismiss = { prompting = null }) }
        faceRetry?.let { retry ->
            HappyAlert(
                Alert(
                    stringResource(R.string.home_dock_bot_face_failed_title),
                    stringResource(
                        if (retry.failure.leg == BotFaceLeg.Uploading) R.string.home_dock_bot_face_upload_failed else R.string.home_dock_bot_face_failed,
                        retry.bot.name.trim(),
                    ),
                    listOf(
                        AlertButton(stringResource(R.string.home_dock_bot_not_now)) { retry.open() },
                        AlertButton(stringResource(R.string.home_dock_bot_try_again)) {
                            // Only the face, on the bot already made; another failure offers it again.
                            scope.launch {
                                val again = services.retryBotFace(context, retry.sessionId, retry.bot.faceSeed)
                                if (again == null) retry.open() else faceRetry = retry.copy(failure = again)
                            }
                        },
                    ),
                ),
                onDismiss = { faceRetry = null },
            )
        }
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
}

/**
 * new/index.tsx on a phone, reached from the empty home's "Start New
 * Session": the header (a 24 chevron-back in a 48 target, then "Start New
 * Session" 16/20 semibold start-aligned, both in the text colour), then the
 * dock's focused composer as the screen itself — the rows over the composer
 * at the bottom, a picker in their place, the progress line and Stop.
 *
 * The back button is the screen's own, so it stays under the tablet shell
 * too: happy-app draws it whenever the screen is native, and nothing hides it.
 */
@Composable
fun NewSessionScreen(dock: NewSessionDock, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(modifier = modifier.fillMaxSize().background(colors.grouped.background).testTag(NewSessionTags.SCREEN)) {
        Header(
            alignment = TitleAlignment.Start,
            left = {
                val back = stringResource(R.string.common_back)
                Box(
                    modifier = Modifier
                        .testTag(NewSessionTags.BACK)
                        .size(48.dp)
                        .clickable(role = Role.Button, onClick = onBack)
                        .semantics { contentDescription = back },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Ionicon.ChevronBack, 24.dp, colors.text)
                }
            },
            titleContent = {
                Text(
                    stringResource(R.string.new_session_title),
                    style = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold),
                    color = colors.text,
                    maxLines = 1,
                    modifier = Modifier.testTag(NewSessionTags.TITLE).semantics { heading() },
                )
            },
        )
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            HomeDockFocus(dock.state, dock.actions, standalone = true)
        }
    }
    dock.dialogs()
}
