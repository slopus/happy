package com.slopus.happy.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.model.MachineChoice
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.home.HomeList
import com.slopus.happy.ui.home.HomeListHost
import com.slopus.happy.ui.home.HomeListScope
import com.slopus.happy.ui.home.HomeNavigation
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

object TabletSidebarTags {
    const val SIDEBAR = "tablet.sidebar"
    const val NEW_SESSION = "tablet.newSession"
    const val ARCHIVE = "tablet.archive"
    const val CONTENT = "tablet.sidebarContent"
    const val LOADING = "tablet.sidebarLoading"
    const val SETTINGS = "tablet.settings"
}

/** SidebarView.tsx. */
object TabletSidebarSpec {
    val controlsMarginHorizontal = 16.dp
    val controlsMarginTop = 8.dp
    val controlsMarginBottom = 4.dp
    val controlsGap = 8.dp
    val newSessionPaddingVertical = 10.dp
    val newSessionPaddingHorizontal = 14.dp
    val newSessionGap = 8.dp
    val newSessionIcon = 16.dp
    val buttonRadius = 10.dp
    val archiveButton = 40.dp
    val archiveIcon = 18.dp
    val settingsPaddingHorizontal = 16.dp
    val settingsPaddingVertical = 14.dp
    val settingsGap = 10.dp
    val settingsIcon = 18.dp
    /** SessionsList.tsx's default `bottomContentInset`, under the navigation bar's inset. */
    val listBottomInset = 128.dp
    val spinner = 20.dp
    val newSessionText = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)
    val settingsText = happyTextStyle(fontSize = 14)
}

/**
 * SidebarView.tsx: one column on the grouped background inside a hairline
 * border, starting under the status bar and the header row (where the
 * persistent header's controls sit).
 * - New session (a hairline frame rounded 10, padded 10/14, a 16 glyph 8
 *   before its 14 semibold label) fills the row, 16 in, 8 below the header
 *   and 4 above the list; the 40 archive toggle follows it 8 on, only while
 *   there is an archive, filled while archived sessions show.
 * - MainView.tsx's sidebar variant: a spinner until the first read, then
 *   [EmptySessionsTablet] or Home's list ([HomeList]) with the open session
 *   selected, flush at the top and 128 past the navigation bar at the end.
 *   Grouped by project, it is SessionsList's own hierarchy
 *   ([TabletGroupedList]), not home's project cards.
 * - The Settings row: a hairline on top, padded 14/16, an 18 glyph 10 before
 *   its 14 label.
 */
@Composable
fun TabletSidebar(
    graph: AppGraph,
    navigation: HomeNavigation,
    selectedSessionId: String?,
    headerHeight: Dp,
    modifier: Modifier = Modifier,
) {
    val services = remember(graph) { HomeServices.of(graph) }
    val snapshot by services.snapshots.collectAsStateWithLifecycle()
    val machines = remember(snapshot?.machines) { collectMachineChoices(snapshot?.machines.orEmpty()) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var stopping by remember { mutableStateOf(emptySet<String>()) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val errorTitle = stringResource(R.string.common_error)
    val ok = stringResource(R.string.common_ok)
    val stopFailed = stringResource(R.string.session_info_failed_to_archive_session)
    val unknown = stringResource(R.string.status_unknown)
    val grouped = remember(services, navigation, context) {
        TabletGroupedActions(
            onStop = { id ->
                if (id !in stopping) {
                    stopping = stopping + id
                    scope.launch {
                        val result = try {
                            services.sessionActions.kill(id)
                        } finally {
                            stopping = stopping - id
                        }
                        if (!result.success) alert = Alert(errorTitle, result.message ?: stopFailed, listOf(AlertButton(ok)))
                    }
                }
            },
            onNewInCheckout = { first ->
                services.newSession(context.applicationContext).prepareCheckout(first?.machineId, first?.path, first?.homeDir)
                navigation.onNewSession()
            },
        )
    }
    HomeListHost(graph, navigation) { host ->
        // Only derived while the sidebar is grouped by project.
        val groupedRows = if (host.grouping == SessionListGrouping.Project) {
            val rows = remember(services, unknown) { tabletGroupedRows(graph, services, unknown) }
            rows.collectAsStateWithLifecycle(null).value
        } else {
            null
        }
        TabletSidebarContent(host, machines, selectedSessionId, headerHeight, modifier, groupedRows, grouped, stopping)
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

/** SessionsList's grouped rows from Home's snapshot, derived off the main thread. */
private fun tabletGroupedRows(graph: AppGraph, services: HomeServices, unknownText: String): Flow<List<TabletGroupedRow>> = combine(
    services.snapshots.filterNotNull().filter { it.ready },
    graph.settings.settings.map { it.hideInactiveSessions }.distinctUntilChanged(),
    services.reads.unreadSessionIds,
    services.archiver.archiving,
) { snapshot, archiveHidden, unread, archiving ->
    val zone = ZoneId.systemDefault()
    deriveTabletGroupedList(snapshot, archiveHidden, unread, archiving, unknownText, zone, LocalDate.now(zone))
}
    .distinctUntilChanged()
    .flowOn(Dispatchers.Default)

@Composable
fun TabletSidebarContent(
    host: HomeListScope,
    machines: List<MachineChoice>,
    selectedSessionId: String?,
    headerHeight: Dp,
    modifier: Modifier = Modifier,
    groupedRows: List<TabletGroupedRow>? = null,
    grouped: TabletGroupedActions = TabletGroupedActions(onStop = {}, onNewInCheckout = {}),
    stopping: Set<String> = emptySet(),
) {
    val colors = HappyTheme.colors
    val line = hairline()
    val state = host.state
    Column(
        modifier = modifier
            .fillMaxSize()
            .testTag(TabletSidebarTags.SIDEBAR)
            .background(colors.grouped.background)
            .border(line, colors.divider)
            .padding(line)
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(top = headerHeight),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = TabletSidebarSpec.controlsMarginHorizontal,
                    end = TabletSidebarSpec.controlsMarginHorizontal,
                    top = TabletSidebarSpec.controlsMarginTop,
                    bottom = TabletSidebarSpec.controlsMarginBottom,
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TabletSidebarSpec.controlsGap),
        ) {
            NewSessionButton(host.navigation.onNewSession, Modifier.weight(1f))
            if (state?.hasArchivedSessions == true) {
                ArchiveButton(hidden = state.archiveHidden, onClick = { host.callbacks.onSetArchiveHidden(!state.archiveHidden) })
            }
        }
        com.slopus.happy.ui.voice.VoiceStatusBar(sidebar = true)
        Box(modifier = Modifier.weight(1f).fillMaxWidth().testTag(TabletSidebarTags.CONTENT)) {
            when {
                state == null -> CircularProgressIndicator(
                    color = colors.textSecondary,
                    strokeWidth = 2.dp,
                    modifier = Modifier.align(Alignment.Center).size(TabletSidebarSpec.spinner).testTag(TabletSidebarTags.LOADING),
                )
                state.rows.isEmpty() -> EmptySessionsTablet(
                    machines = machines,
                    onNewSession = host.navigation.onNewSession,
                    onTroubleshoot = host.navigation.onTroubleshoot,
                )
                // MainView.tsx's sidebar mounts SessionsList, whose project grouping is its own.
                host.grouping == SessionListGrouping.Project -> if (groupedRows == null) {
                    Box(Modifier.fillMaxSize())
                } else {
                    TabletGroupedList(
                        rows = groupedRows,
                        offlineBanner = state.offlineBanner,
                        update = host.update,
                        callbacks = host.callbacks,
                        actions = host.actions,
                        grouped = grouped,
                        selectedSessionId = selectedSessionId,
                        bottomSpacer = {
                            Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).height(TabletSidebarSpec.listBottomInset))
                        },
                        stopping = stopping,
                    )
                }
                else -> HomeList(
                    state = state,
                    callbacks = host.callbacks,
                    actions = host.actions,
                    update = host.update,
                    contentTop = 0.dp,
                    bottomSpacer = {
                        Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars).height(TabletSidebarSpec.listBottomInset))
                    },
                    selectedSessionId = selectedSessionId,
                )
            }
        }
        SettingsRow(host.navigation.onSettings)
    }
}

@Composable
private fun NewSessionButton(onClick: () -> Unit, modifier: Modifier) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(TabletSidebarSpec.buttonRadius)
    val line = hairline()
    Row(
        modifier = modifier
            .testTag(TabletSidebarTags.NEW_SESSION)
            .clip(shape)
            .background(colors.surface)
            .border(line, colors.divider, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(line)
            .padding(horizontal = TabletSidebarSpec.newSessionPaddingHorizontal, vertical = TabletSidebarSpec.newSessionPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TabletSidebarSpec.newSessionGap),
    ) {
        Icon(Ionicon.CreateOutline, TabletSidebarSpec.newSessionIcon, colors.text)
        Text(stringResource(R.string.sidebar_new_session), style = TabletSidebarSpec.newSessionText, color = colors.text, maxLines = 1)
    }
}

@Composable
private fun ArchiveButton(hidden: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(TabletSidebarSpec.buttonRadius)
    val label = stringResource(if (hidden) R.string.sidebar_show_archived else R.string.sidebar_hide_archived)
    Box(
        modifier = Modifier
            .testTag(TabletSidebarTags.ARCHIVE)
            .size(TabletSidebarSpec.archiveButton)
            .clip(shape)
            .background(if (hidden) colors.surface else colors.surfaceSelected)
            .border(hairline(), colors.divider, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                selected = !hidden
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(if (hidden) Ionicon.ArchiveOutline else Ionicon.Archive, TabletSidebarSpec.archiveIcon, colors.text)
    }
}

@Composable
private fun SettingsRow(onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(TabletSidebarTags.SETTINGS)
            .clickable(role = Role.Button, onClick = onClick)
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        Box(Modifier.fillMaxWidth().height(hairline()).background(colors.divider))
        Row(
            modifier = Modifier.padding(horizontal = TabletSidebarSpec.settingsPaddingHorizontal, vertical = TabletSidebarSpec.settingsPaddingVertical),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TabletSidebarSpec.settingsGap),
        ) {
            Icon(Ionicon.SettingsOutline, TabletSidebarSpec.settingsIcon, colors.text)
            Text(stringResource(R.string.settings_title), style = TabletSidebarSpec.settingsText, color = colors.text)
        }
    }
}
