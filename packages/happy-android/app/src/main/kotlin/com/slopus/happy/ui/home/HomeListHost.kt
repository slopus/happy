package com.slopus.happy.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.BuildConfig
import com.slopus.happy.R
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.WorkspaceOrigin
import com.slopus.happy.model.forkSource
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.changelog.Changelog
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.session.DuplicateSheet

/** What [HomeListHost] hands its content: the list's state and its wiring. */
class HomeListScope(
    val state: HomeListState?,
    val connectionStatus: ConnectionStatus,
    val grouping: SessionListGrouping,
    val callbacks: HomeListCallbacks,
    val actions: HomeScreenActions,
    val update: HomeUpdate?,
    val navigation: HomeNavigation,
    /** The phone home's new-session dock; null in the tablet sidebar. */
    val dock: NewSessionDock?,
)

/**
 * The home list's state, row callbacks, session menus and their alerts and
 * sheets, around [content]. [withDock] (the phone home) adds the new-session
 * dock, which a project's "+" opens on a new workspace; without it (the tablet
 * sidebar) "+" prepares the workspace and opens the new-session screen.
 */
@Composable
fun HomeListHost(graph: AppGraph, navigation: HomeNavigation, withDock: Boolean = false, content: @Composable (HomeListScope) -> Unit) {
    val onOpenSession = navigation.onOpenSession
    val services = remember(graph) { HomeServices.of(graph) }
    val state by services.list.state.collectAsStateWithLifecycle()
    val settings by graph.settings.settings.collectAsStateWithLifecycle()
    val local by graph.localSettings.values.collectAsStateWithLifecycle()
    val connection by graph.connectionStatus.collectAsStateWithLifecycle()
    val updateUrl by services.updateUrl.collectAsStateWithLifecycle()
    val resources = LocalResources.current
    val latestChangelog = remember(resources) { Changelog.bundled(resources).latestTitle }
    val lastViewedChangelog by graph.changelog.lastViewedTitle.collectAsStateWithLifecycle()
    // useChangelog: a first install has seen everything so far; only what comes later is news.
    LaunchedEffect(latestChangelog) {
        if (graph.changelog.lastViewedTitle.value.isEmpty() && latestChangelog.isNotEmpty()) graph.changelog.markViewed(latestChangelog)
    }
    val update = HomeUpdate.resolve(updateUrl, lastViewedChangelog.isNotEmpty() && graph.changelog.hasUnread(latestChangelog))
    val uriHandler = LocalUriHandler.current
    var alert by remember { mutableStateOf<Alert?>(null) }
    val showAlert = remember { { next: Alert -> alert = next } }
    var duplicating by remember { mutableStateOf<Session?>(null) }
    val menus = rememberSessionMenus(
        services = services,
        continuationExperiments = settings.expResumeSession,
        devMode = BuildConfig.DEBUG || local.devModeEnabled,
        onOpenSession = onOpenSession,
        onDetails = navigation.onDetails,
        onDuplicate = { duplicating = it },
        showAlert = showAlert,
    )
    var dockFocused by rememberSaveable { mutableStateOf(false) }
    val dock = if (withDock) {
        rememberNewSessionDock(
            graph,
            focused = dockFocused,
            onFocusChange = { dockFocused = it },
            onStarted = onOpenSession,
            showScrim = state?.rows?.isNotEmpty() == true,
        )
    } else {
        null
    }
    val context = LocalContext.current
    // ProjectHomeList's "+": the dock (or the new-session screen) opens on a new workspace of that project.
    val onCreateWorkspace = remember(services, context, withDock, navigation) {
        { origin: WorkspaceOrigin ->
            services.newSession(context.applicationContext).prepareWorkspace(origin.machineId, origin.projectId, origin.path)
            if (withDock) dockFocused = true else navigation.onNewSession()
        }
    }
    // SessionsList's requestReview(), once its list has sessions.
    val reviewable = asksForReview(state, phone = withDock)
    val reviewStrings = ReviewStrings(
        title = stringResource(R.string.review_enjoying_app),
        message = stringResource(R.string.review_feedback_prompt),
        yes = stringResource(R.string.review_yes_i_love_it),
        no = stringResource(R.string.review_not_really),
    )
    LaunchedEffect(reviewable) {
        if (!reviewable) return@LaunchedEffect
        val activity = context.findActivity() ?: return@LaunchedEffect
        val (prompter, store) = services.review(context.applicationContext)
        prompter.run(
            isAvailable = store::isAvailable,
            ask = { confirm(showAlert, reviewStrings.title, reviewStrings.message, confirmText = reviewStrings.yes, cancelText = reviewStrings.no) },
            review = { store.request(activity) },
        )
    }
    val createWorkspaceLabel = stringResource(R.string.home_create_workspace)
    val cancelLabel = stringResource(R.string.common_cancel)

    val callbacks = remember(services, menus, navigation) {
        HomeListCallbacks(
            onOpen = onOpenSession,
            onMenu = menus::open,
            onArchive = menus::archive,
            onSetArchiveHidden = { hidden -> graph.settings.change { it.copy(hideInactiveSessions = hidden) } },
            onToggleProject = { id ->
                graph.localSettings.change { it.copy(expandedProjects = it.expandedProjects + (id to it.expandedProjects[id].let { open -> open != true })) }
            },
            onOpenMachine = navigation.onOpenMachine,
            onCreateWorkspace = onCreateWorkspace,
            onProjectMenu = { name, origin ->
                alert = Alert(name, null, listOf(AlertButton(cancelLabel), AlertButton(createWorkspaceLabel) { onCreateWorkspace(origin) }))
            },
            onPressDown = { id -> graph.account.value?.messages?.preload(id) },
        )
    }
    val actions = remember(navigation, uriHandler) {
        HomeScreenActions(
            onSettings = navigation.onSettings,
            onAppearance = navigation.onAppearance,
            onSetGrouping = { grouping -> graph.settings.change { it.copy(sessionListGrouping = grouping) } },
            onNewSession = navigation.onNewSession,
            onTroubleshoot = navigation.onTroubleshoot,
            onOpenUrl = uriHandler::openUri,
            onWhatsNew = navigation.onWhatsNew,
        )
    }

    ProvideAvatarSettings(settings) {
        content(HomeListScope(state, connection, settings.sessionListGrouping, callbacks, actions, update, navigation, dock))
    }
    dock?.dialogs?.invoke()
    duplicating?.let { session ->
        DuplicateSheet(
            source = session.forkSource(),
            continuations = services.continuations,
            onDismiss = { duplicating = null },
            onDuplicated = onOpenSession,
        )
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}
