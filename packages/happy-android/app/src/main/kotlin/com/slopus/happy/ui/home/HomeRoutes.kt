package com.slopus.happy.ui.home

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.Settings
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.forkSource
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HappyJson
import com.slopus.happy.sync.MachinePresence
import com.slopus.happy.sync.SessionPresence
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.AvatarSettings
import com.slopus.happy.ui.components.AvatarStyle
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.LocalAvatarSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.WeakHashMap

/**
 * The home screens' long-lived state, one per [AppGraph]: the list derived
 * in the background and kept warm between visits, the archive in flight,
 * and the store-version check.
 */
class HomeServices private constructor(graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val sessionActions: SessionActions = ServerSessionActions { graph.account.value?.api }
    val rpc: SessionRpc = SessionRpc.Unavailable
    val archiver = SessionArchiver(sessionActions)

    @OptIn(ExperimentalCoroutinesApi::class)
    val snapshots: StateFlow<HomeSnapshot?> = graph.account
        .flatMapLatest { account ->
            homeSnapshots(
                graph.store,
                account?.presence?.sessions ?: flowOf(emptyMap<String, SessionPresence>()),
                account?.presence?.machines ?: flowOf(emptyMap<String, MachinePresence>()),
            )
        }
        .stateIn(scope, SharingStarted.Eagerly, null)

    val list = HomeListModel(
        snapshots = snapshots,
        settings = graph.settings.settings,
        localSettings = graph.localSettings.values,
        // Read state belongs to the chat; nothing is unread until it lands.
        unreadSessionIds = flowOf(emptySet()),
        archivingSessionIds = archiver.archiving,
        scope = scope,
    )

    private val update = MutableStateFlow<String?>(null)

    /** The store page of a required native update (UpdateBanner's first case). */
    val updateUrl: StateFlow<String?> = update.asStateFlow()

    init {
        scope.launch { update.value = checkNativeUpdate(graph.http, BuildConfig.APPLICATION_ID, BuildConfig.VERSION_NAME) }
    }

    fun session(id: String): Session? = snapshots.value?.sessions?.find { it.id == id }

    fun machine(id: String?): Machine? = id?.let { machineId -> snapshots.value?.machines?.find { it.id == machineId } }

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    companion object {
        private val instances = WeakHashMap<AppGraph, HomeServices>()

        @Synchronized
        fun of(graph: AppGraph): HomeServices = instances.getOrPut(graph) { HomeServices(graph) }
    }
}

/**
 * sync.ts fetchNativeUpdate: POST /v1/version with this build; the store
 * URL when the server says an update is required, else null (also on any
 * failure: the banner is a nicety).
 */
suspend fun checkNativeUpdate(http: HappyHttp, appId: String, version: String): String? = try {
    val body = JsonObject(mapOf("platform" to JsonPrimitive("android"), "version" to JsonPrimitive(version), "app_id" to JsonPrimitive(appId)))
    val response = http.post("/v1/version", body, JsonObject.serializer(), JsonObject.serializer())
    val required = response["update_required"]?.jsonPrimitive?.booleanOrNull == true
    response["update_url"]?.jsonPrimitive?.contentOrNull?.takeIf { required && it.isNotEmpty() }
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}

/**
 * The home routes. [onOpenSession] belongs to the chat, [onLinkComputer],
 * [onConnectUrl] and [onTroubleshoot] to onboarding; they're wired in
 * HappyApp as those land.
 */
fun NavGraphBuilder.homeRoutes(
    graph: AppGraph,
    nav: NavHostController,
    onOpenSession: (sessionId: String) -> Unit = {},
    onLinkComputer: () -> Unit = {},
    onConnectUrl: (url: String) -> Unit = {},
    onTroubleshoot: () -> Unit = {},
) {
    composable<HomeRoute> {
        HomeRouteScreen(
            graph = graph,
            onSettings = { nav.navigate(SettingsRoute) },
            onAppearance = { nav.navigate(AppearanceRoute) },
            onOpenSession = onOpenSession,
            onLinkComputer = onLinkComputer,
            onConnectUrl = onConnectUrl,
            onTroubleshoot = onTroubleshoot,
            onNewSession = {},
            onDetails = null,
            onCreateWorkspace = {},
        )
    }
}

/** The synced avatar settings, for every avatar under [content]. */
@Composable
fun ProvideAvatarSettings(settings: Settings, content: @Composable () -> Unit) {
    val avatars = remember(settings.avatarStyle, settings.avatarMonochrome, settings.showFlavorIcons, settings.showHarnessIconInSessionHeader) {
        AvatarSettings(
            style = AvatarStyle.normalize(settings.avatarStyle),
            monochrome = settings.avatarMonochrome,
            showFlavorIcons = settings.showFlavorIcons,
            showHarnessIconInSessionHeader = settings.showHarnessIconInSessionHeader,
        )
    }
    CompositionLocalProvider(LocalAvatarSettings provides avatars, content = content)
}

@Composable
private fun HomeRouteScreen(
    graph: AppGraph,
    onSettings: () -> Unit,
    onAppearance: () -> Unit,
    onOpenSession: (String) -> Unit,
    onLinkComputer: () -> Unit,
    onConnectUrl: (String) -> Unit,
    onTroubleshoot: () -> Unit,
    onNewSession: () -> Unit,
    onDetails: ((String) -> Unit)?,
    onCreateWorkspace: (WorkspaceOrigin) -> Unit,
) {
    val services = remember(graph) { HomeServices.of(graph) }
    val state by services.list.state.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val connection by graph.connectionStatus.collectAsStateWithLifecycle()
    val updateUrl by services.updateUrl.collectAsStateWithLifecycle()
    val uriHandler = LocalUriHandler.current
    var alert by remember { mutableStateOf<Alert?>(null) }
    val showAlert = remember { { next: Alert -> alert = next } }
    val menus = rememberSessionMenus(
        services = services,
        continuationExperiments = settings.expResumeSession,
        devMode = BuildConfig.DEBUG || local.devModeEnabled,
        onOpenSession = onOpenSession,
        onDetails = onDetails,
        showAlert = showAlert,
    )
    val createWorkspaceLabel = stringResource(R.string.home_create_workspace)
    val cancelLabel = stringResource(R.string.common_cancel)

    val callbacks = remember(services, menus, onOpenSession, onCreateWorkspace) {
        HomeListCallbacks(
            onOpen = onOpenSession,
            onMenu = menus::open,
            onArchive = menus::archive,
            onSetArchiveHidden = { hidden -> graph.settings.change { it.copy(hideInactiveSessions = hidden) } },
            onToggleProject = { id ->
                graph.localSettings.change { it.copy(expandedProjects = it.expandedProjects + (id to it.expandedProjects[id].let { open -> open != true })) }
            },
            onOpenMachine = {},
            onCreateWorkspace = onCreateWorkspace,
            onProjectMenu = { name, origin ->
                alert = Alert(name, null, listOf(AlertButton(cancelLabel), AlertButton(createWorkspaceLabel) { onCreateWorkspace(origin) }))
            },
        )
    }
    val actions = remember(onSettings, onAppearance, onNewSession, onLinkComputer, onConnectUrl, onTroubleshoot, uriHandler) {
        HomeScreenActions(
            onSettings = onSettings,
            onAppearance = onAppearance,
            onSetGrouping = { grouping -> graph.settings.change { it.copy(sessionListGrouping = grouping) } },
            onNewSession = onNewSession,
            onLinkComputer = onLinkComputer,
            onConnectUrl = onConnectUrl,
            onTroubleshoot = onTroubleshoot,
            onOpenUrl = uriHandler::openUri,
        )
    }

    ProvideAvatarSettings(settings) {
        HomeScreen(
            state = state,
            connectionStatus = connection,
            grouping = settings.sessionListGrouping,
            callbacks = callbacks,
            actions = actions,
            updateUrl = updateUrl,
        )
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

/** The session alert and the archive, as the list's rows run them. */
class SessionMenus(
    private val services: HomeServices,
    private val buildMenu: (Session) -> Alert?,
    private val showError: (String?, Boolean) -> Unit,
) {
    /** useSessionActionAlert: "Session", one button per action, then Cancel. */
    fun open(sessionId: String) {
        val session = services.session(sessionId) ?: return
        buildMenu(session)
    }

    /** useSessionArchiveAction: the same archive the menu runs. */
    fun archive(sessionId: String) {
        val session = services.session(sessionId) ?: return
        services.launch {
            val result = services.archiver.archive(session)
            if (result is ArchiveResult.Failed) showError(result.message, result.bot)
        }
    }
}

@Composable
private fun rememberSessionMenus(
    services: HomeServices,
    continuationExperiments: Boolean,
    devMode: Boolean,
    onOpenSession: (String) -> Unit,
    onDetails: ((String) -> Unit)?,
    showAlert: (Alert) -> Unit,
): SessionMenus {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val strings = SessionMenuStrings(
        title = stringResource(R.string.session_actions_title),
        details = stringResource(R.string.profile_details),
        resume = stringResource(R.string.session_info_resume_session),
        fork = stringResource(R.string.session_fork_action),
        duplicate = stringResource(R.string.session_duplicate_action),
        copyMetadata = stringResource(R.string.session_info_copy_metadata),
        archive = stringResource(R.string.session_archive_action),
        cancel = stringResource(R.string.common_cancel),
        error = stringResource(R.string.common_error),
        ok = stringResource(R.string.common_ok),
        archiveFailed = stringResource(R.string.session_info_failed_to_archive_session),
        botArchiveFailed = stringResource(R.string.home_bot_archive_offline),
        forkFailed = stringResource(R.string.session_fork_error_generic),
        resumeFailed = stringResource(R.string.session_info_resume_session_subtitle),
        blocks = mapOf(
            ResumeBlock.MissingMachine to stringResource(R.string.session_info_resume_session_missing_machine),
            ResumeBlock.MissingBackendId to stringResource(R.string.session_info_resume_session_missing_backend_id),
            ResumeBlock.SameMachineOnly to stringResource(R.string.session_info_resume_session_same_machine_only),
            ResumeBlock.MachineOffline to stringResource(R.string.session_info_resume_session_machine_offline),
        ),
        metadataCopied = stringResource(R.string.session_info_metadata_copied),
        success = stringResource(R.string.common_success),
    )
    return remember(services, continuationExperiments, devMode, onOpenSession, onDetails, strings, context, scope, showAlert) {
        fun error(message: String) = showAlert(Alert(strings.error, message, listOf(AlertButton(strings.ok))))
        lateinit var menus: SessionMenus
        menus = SessionMenus(
            services = services,
            buildMenu = { session ->
                val machine = services.machine(session.metadata?.machineId)
                val ids = sessionActionIds(session, machine, continuationExperiments, devMode)
                val buttons = ids.mapNotNull { id ->
                    when (id) {
                        SessionActionId.Details -> onDetails?.let { AlertButton(strings.details) { it(session.id) } }
                        SessionActionId.Resume -> AlertButton(strings.resume) {
                            val availability = resumeAvailability(session, machine)
                            val machineId = session.metadata?.machineId
                            if (!availability.canResume || machineId == null) {
                                error(availability.block?.let(strings.blocks::getValue) ?: strings.resumeFailed)
                            } else {
                                scope.launch {
                                    when (val result = services.rpc.resume(machineId, session.id)) {
                                        is SpawnResult.Success -> onOpenSession(result.sessionId)
                                        is SpawnResult.Failure -> error(result.message ?: strings.resumeFailed)
                                    }
                                }
                            }
                        }
                        SessionActionId.Fork -> AlertButton(strings.fork) {
                            val source = session.forkSource() ?: return@AlertButton
                            scope.launch {
                                when (val result = services.rpc.fork(source)) {
                                    is SpawnResult.Success -> onOpenSession(result.sessionId)
                                    is SpawnResult.Failure -> error(result.message ?: strings.forkFailed)
                                }
                            }
                        }
                        // DuplicateSheet lives on session info; offered once that screen is wired.
                        SessionActionId.Duplicate -> onDetails?.let { AlertButton(strings.duplicate) { it(session.id) } }
                        SessionActionId.CopyMetadata -> AlertButton(strings.copyMetadata) {
                            val metadata = session.metadata ?: return@AlertButton error(strings.error)
                            copyToClipboard(context, prettyJson.encodeToString(JsonObject.serializer(), metadata.raw))
                            showAlert(Alert(strings.success, strings.metadataCopied, listOf(AlertButton(strings.ok))))
                        }
                        SessionActionId.Archive -> AlertButton(strings.archive, destructive = true) { menus.archive(session.id) }
                    }
                }
                Alert(strings.title, null, buttons + AlertButton(strings.cancel)).also(showAlert)
            },
            showError = { message, bot -> error(message ?: if (bot) strings.botArchiveFailed else strings.archiveFailed) },
        )
        menus
    }
}

private data class SessionMenuStrings(
    val title: String,
    val details: String,
    val resume: String,
    val fork: String,
    val duplicate: String,
    val copyMetadata: String,
    val archive: String,
    val cancel: String,
    val error: String,
    val ok: String,
    val archiveFailed: String,
    val botArchiveFailed: String,
    val forkFailed: String,
    val resumeFailed: String,
    val blocks: Map<ResumeBlock, String>,
    val metadataCopied: String,
    val success: String,
)

private val prettyJson = Json(HappyJson) { prettyPrint = true }

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("session metadata", text))
}
