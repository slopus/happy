package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import com.slopus.happy.model.WorktreeToggle
import com.slopus.happy.model.ProjectHomeRow
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.longClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.sync.SessionPresence
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The phone home screen against happy-app's layout:
 * - MainView's header: logo 19 in a 32 box; "Sessions" (`tabs.sessions`) 16/20 centred; the
 *   status line (11/16, 6 dot) hangs 2 into the title's bottom while the
 *   socket isn't connected; the filter and settings buttons are 44 squares
 *   split by a 22-high hairline, the gear 16 from the edge.
 * - FlatSessionRow: 60 avatar at 16, 10 above and below; 12 to the text;
 *   title 17/22, project 15/20, workspace line 1 below at 18 minimum, so a
 *   row is 81; the top-right slot is at least 56 and ends 16 from the edge;
 *   the hairline runs from 88 to the edge. Swiping uncovers a 112 Archive
 *   action; a long press opens the session menu.
 * - SessionsList: the list starts 12 under the header; the archive toggle
 *   sits 24 below the last live row.
 * - ProjectHomeList: 8 + 52 project card with a 28 avatar at 16, 48 worktrees.
 * - SessionsListWrapper: spinner while loading, EmptyMainScreen's states.
 * - One changed session recomposes its own row and no other.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val studio = machine("m1", machineMetadata { put("displayName", "Studio") })

    private val opened = mutableListOf<String>()
    private val menus = mutableListOf<String>()
    private val archived = mutableListOf<String>()
    private val archiveHidden = mutableListOf<Boolean>()

    private val callbacks = HomeListCallbacks(
        onOpen = { opened += it },
        onMenu = { menus += it },
        onArchive = { archived += it },
        onSetArchiveHidden = { archiveHidden += it },
        onToggleProject = {},
        onOpenMachine = {},
        onCreateWorkspace = {},
        onProjectMenu = { _, _ -> },
    )
    private var newSession = 0
    private var whatsNew = 0
    private val actions = HomeScreenActions(
        onSettings = {},
        onAppearance = {},
        onSetGrouping = {},
        onNewSession = { newSession++ },
        onTroubleshoot = {},
        onOpenUrl = {},
        onWhatsNew = { whatsNew++ },
    )

    private fun cli(id: String, at: Long = noon, active: Boolean = true) = session(
        id,
        metadata = metadata(path = "/Users/dev/$id") { put("machineId", "m1") },
        active = active,
        lastMessageSentAt = at,
    )

    private fun state(
        sessions: List<Session>,
        grouping: SessionListGrouping = SessionListGrouping.Flat,
        hidden: Boolean = true,
        machines: List<com.slopus.happy.model.Machine> = listOf(studio),
        unread: Set<String> = emptySet(),
    ) = deriveHomeList(
        HomeListInputs(HomeSnapshot(sessions, machines), grouping, hidden, emptySet(), unread, emptySet()),
        ZoneOffset.UTC,
        LocalDate.of(2026, 10, 16),
    )

    private fun show(state: HomeListState?, status: ConnectionStatus = ConnectionStatus.CONNECTED) {
        rule.setHappyContent {
            HomeScreen(state, status, state?.grouping ?: SessionListGrouping.Flat, callbacks, actions)
        }
    }

    @Test
    fun header() {
        show(state(listOf(cli("a"))))
        assertBox("logo box", rule.node(HomeTags.LOGO).bounds, 24.dp, 16.dp, 32.dp, 32.dp)
        val settings = rule.node(HomeTags.SETTINGS).bounds
        assertBox("settings", settings, (PHONE_WIDTH - 16 - 44).dp, 10.dp, 44.dp, 44.dp)
        val divider = rule.node(HomeTags.ACTION_DIVIDER).bounds
        assertDp("divider meets the gear", settings.left, divider.right)
        assertDp("divider height", 22, divider.bottom - divider.top)
        assertDp("divider centred", 32, (divider.top + divider.bottom) / 2)
        assertBox("filter", rule.node(HomeTags.FILTER).bounds, divider.left - 44.dp, 10.dp, 44.dp, 44.dp)
        val title = rule.node(HomeTags.TITLE).bounds
        assertDp("title centred", (PHONE_WIDTH / 2f).dp, (title.left + title.right) / 2)
        assertDp("title centred in the bar", 32, (title.top + title.bottom) / 2)
        assertDp("title line height", 20, title.bottom - title.top)
        rule.onAllNodesWithTag(HomeTags.STATUS, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun headerStatusHangsUnderTheTitle() {
        show(state(listOf(cli("a"))), ConnectionStatus.DISCONNECTED)
        val title = rule.node(HomeTags.TITLE).bounds
        val status = rule.node(HomeTags.STATUS).bounds
        assertDp("title stays centred in the bar", 32, (title.top + title.bottom) / 2)
        assertDp("status top", title.bottom - 2.dp, status.top)
        assertDp("status line", 16, status.bottom - status.top)
        assertDp("status centred", (PHONE_WIDTH / 2f).dp, (status.left + status.right) / 2)
    }

    @Test
    fun flatRowGeometry() {
        show(state(listOf(cli("a"), cli("b", noon - 1))))
        val rows = rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)
        rows.assertCountEquals(2)
        val row = rows[0].bounds
        assertBox("first row", row, 0.dp, (64 + 12).dp, PHONE_WIDTH.dp, 81.dp)
        val avatar = rule.onAllNodesWithTag(FlatRowTags.AVATAR, useUnmergedTree = true)[0].bounds
        assertBox("avatar", avatar, 16.dp, row.top + 10.5.dp, 60.dp, 60.dp)
        val title = rule.onAllNodesWithTag(FlatRowTags.TITLE, useUnmergedTree = true)[0].bounds
        assertDp("title left", 88, title.left)
        assertDp("title top", row.top + 10.dp, title.top)
        assertDp("title line", 22, title.bottom - title.top)
        val corner = rule.onAllNodesWithTag(FlatRowTags.TOP_RIGHT, useUnmergedTree = true)[0].bounds
        assertDp("corner ends 16 in", (PHONE_WIDTH - 16).dp, corner.right)
        assertTrue("corner at least 56", corner.right - corner.left >= 56.dp - 0.34.dp)
        assertDp("corner 8 after the title", title.right + 8.dp, corner.left)
        val project = rule.onAllNodesWithTag(FlatRowTags.PROJECT, useUnmergedTree = true)[0].bounds
        assertDp("project under the title", title.bottom, project.top)
        assertDp("project line", 20, project.bottom - project.top)
        val divider = rule.node(FlatRowTags.DIVIDER).bounds
        assertBox("divider", divider, 88.dp, row.bottom - divider.height(), (PHONE_WIDTH - 88).dp, divider.height())
        // Only the first row draws a divider: the last has none.
        rule.onAllNodesWithTag(FlatRowTags.DIVIDER, useUnmergedTree = true).assertCountEquals(1)
        assertBox("second row", rows[1].bounds, 0.dp, row.bottom, PHONE_WIDTH.dp, 81.dp)
    }

    private fun androidx.compose.ui.unit.DpRect.height() = bottom - top

    @Test
    fun rowOpensOnTapAndShowsTheMenuOnLongPress() {
        show(state(listOf(cli("a"))))
        rule.node(FlatRowTags.ROW).performClick()
        rule.node(FlatRowTags.ROW).performTouchInput { longClick() }
        assertEquals(listOf("a"), opened)
        assertEquals(listOf("a"), menus)
    }

    @Test
    fun swipeUncoversTheArchiveAction() {
        show(state(listOf(cli("a"))))
        rule.node(FlatRowTags.ROW).performTouchInput { swipeLeft() }
        rule.waitForIdle()
        val row = rule.node(FlatRowTags.ROW).bounds
        val action = rule.node(FlatRowTags.ARCHIVE_ACTION).bounds
        assertBox("archive action", action, (PHONE_WIDTH - 112).dp, row.top, 112.dp, 81.dp)
        assertDp("row slid by the action's width", -112, row.left)
        rule.node(FlatRowTags.ARCHIVE_ACTION).performClick()
        assertEquals(listOf("a"), archived)
    }

    @Test
    fun archiveToggleAndDayHeaders() {
        show(state(listOf(cli("a"), cli("gone", noon, active = false)), hidden = false))
        val lastLive = rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)[0].bounds
        val toggle = rule.node(HomeTags.ARCHIVE_TOGGLE).bounds
        assertDp("toggle right under the live rows", lastLive.bottom, toggle.top)
        rule.onAllNodesWithTag(HomeTags.DAY_HEADER, useUnmergedTree = true).assertCountEquals(1)
        rule.node(HomeTags.ARCHIVE_TOGGLE).performClick()
        assertEquals(listOf(true), archiveHidden)
    }

    /**
     * HomeListHeader: the offline plaque, then UpdateBanner (a store update
     * outranks What's New), each an inset card 4 under the list's top
     * and 16 above what follows; the changelog card opens What's New.
     */
    @Test
    fun bannersStackAboveTheListAndWhatsNewOpensTheChangelog() {
        assertEquals(HomeUpdate.Native("u"), HomeUpdate.resolve("u", changelogUnread = true))
        assertEquals(HomeUpdate.Changelog, HomeUpdate.resolve(null, changelogUnread = true))
        assertNull(HomeUpdate.resolve(null, changelogUnread = false))

        val two = listOf(studio.copy(active = false), machine("m2", machineMetadata { put("displayName", "Laptop") }, active = false))
        val current = state(listOf(cli("a")), machines = two)
        rule.setHappyContent {
            HomeScreen(current, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions, update = HomeUpdate.Changelog)
        }
        val offline = rule.node(HomeStateTags.OFFLINE_BANNER).bounds
        val changelog = rule.node(HomeStateTags.CHANGELOG_BANNER).bounds
        val row = rule.node(FlatRowTags.ROW).bounds
        assertDp("changelog under the offline plaque", offline.bottom, changelog.top)
        assertDp("rows 16 under the last card's bottom margin", changelog.bottom, row.top)
        rule.node(HomeStateTags.CHANGELOG_BANNER).performClick()
        assertEquals(1, whatsNew)
    }

    @Test
    fun loadingAndEmptyStates() {
        var current by mutableStateOf<HomeListState?>(null)
        var offlineComputers: List<String>? = null
        rule.setHappyContent {
            HomeScreen(
                current, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions,
                linkContent = { Box(Modifier.fillMaxSize()) },
                offlineContent = { computers, _ -> offlineComputers = computers },
            )
        }
        rule.node(HomeTags.LOADING).assertExists()

        current = state(emptyList())
        rule.waitForIdle()
        assertEquals(HomeEmptyState.NoSessions, current!!.emptyState)
        rule.node(HomeStateTags.NO_SESSIONS).assertExists()
        rule.node(HomeStateTags.NEW_SESSION).performClick()
        assertEquals(1, newSession)

        current = state(emptyList(), machines = listOf(studio.copy(active = false)))
        rule.waitForIdle()
        assertEquals(listOf("Studio"), offlineComputers)

        // No computer at all: the first-run link page replaces the whole screen, header included.
        current = state(emptyList(), machines = emptyList())
        rule.waitForIdle()
        rule.node(HomeTags.LINK).assertExists()
        rule.onAllNodesWithTag(HomeTags.FILTER, useUnmergedTree = true).assertCountEquals(0)
        val link = rule.node(HomeTags.LINK).bounds
        assertDp("link page from the top", 0, link.top)
        assertDp("link page full width", PHONE_WIDTH, link.right - link.left)
    }

    /**
     * TalkBack over Home, as MainView, FlatSessionRow and SessionsList label
     * it: "Sessions" is a header; Filter and Settings are named buttons; an
     * unread row's top-right reads "new results" and not the stamp hidden
     * under the dot; the archive toggle is a button, selected while the
     * archive shows. Grouped by project, every row is a button.
     */
    @Test
    fun homeReadsForTalkBack() {
        show(state(listOf(cli("a"), cli("gone", noon, active = false)), hidden = false, unread = setOf("a")))
        rule.onNode(hasText("Sessions") and isHeading(), useUnmergedTree = true).assertExists()
        rule.onNode(hasContentDescription("Filter") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasContentDescription("Settings") and hasRole(Role.Button)).assertExists()
        rule.onAllNodesWithTag(FlatRowTags.TOP_RIGHT, useUnmergedTree = true)[0].assert(hasContentDescription("new results"))
        rule.onAllNodesWithTag(FlatRowTags.TIMESTAMP, useUnmergedTree = true)[0].assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.HideFromAccessibility))
        rule.onAllNodesWithTag(FlatRowTags.TIMESTAMP, useUnmergedTree = true)[1].assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.HideFromAccessibility))
        rule.node(HomeTags.ARCHIVE_TOGGLE).assert(hasRole(Role.Button)).assertIsSelected()
        rule.assertActionsLabelled()
    }

    @Test
    fun projectRowsReadAsButtons() {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        val sessions = listOf(
            session("own", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
            session("wt", metadata = rigMetadata(projectId = "p1", projectName = "happy", workspaceId = "w1", workspaceName = "Gdansk"), lastMessageSentAt = noon),
        )
        show(state(sessions, grouping = SessionListGrouping.Project, machines = listOf(rig)))
        rule.node(ProjectListTags.PROJECT).assert(hasRole(Role.Button))
        rule.onNodeWithTag(ProjectListTags.WORKTREE).assert(hasRole(Role.Button) and hasText("Gdansk"))
        rule.onNode(hasContentDescription("Create workspace in happy", substring = true) and hasRole(Role.Button)).assertExists()
        rule.assertActionsLabelled()
    }

    /**
     * ProjectHomeList.tsx's toggle: `hapticsLight()` on every flip, from a
     * tap or from TalkBack's expand, before the project's worktrees change.
     */
    @Test
    fun theWorktreeToggleTicksLightly() {
        val ticks = mutableListOf<HapticFeedbackType>()
        val toggled = mutableListOf<String>()
        val haptics = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                ticks += hapticFeedbackType
            }
        }
        rule.setHappyContent {
            CompositionLocalProvider(LocalHapticFeedback provides haptics) {
                ProjectHomeRowContent(
                    ProjectHomeRow.Toggle(WorktreeToggle("p1", worktreeCount = 5, hiddenCount = 2, expanded = false, unread = false, working = false, blocked = false)),
                    HomeListCallbacks(
                        onOpen = {}, onMenu = {}, onArchive = {}, onSetArchiveHidden = {}, onToggleProject = { toggled += it },
                        onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
                    ),
                )
            }
        }
        rule.node(ProjectListTags.TOGGLE).performClick()
        rule.node(ProjectListTags.TOGGLE).performSemanticsAction(SemanticsActions.Expand)
        assertEquals(listOf("p1", "p1"), toggled)
        assertEquals(listOf(HapticFeedbackType.ContextClick, HapticFeedbackType.ContextClick), ticks)
    }

    @Test
    fun projectRowsGeometry() {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        val sessions = listOf(
            session("own", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
            session("wt", metadata = rigMetadata(projectId = "p1", projectName = "happy", workspaceId = "w1", workspaceName = "Gdansk"), lastMessageSentAt = noon),
        )
        show(state(sessions, grouping = SessionListGrouping.Project, machines = listOf(rig)))
        val project = rule.node(ProjectListTags.PROJECT).bounds
        assertDp("project row", 52, project.bottom - project.top)
        val worktree = rule.node(ProjectListTags.WORKTREE).bounds
        assertBox("worktree", worktree, 0.dp, project.bottom, PHONE_WIDTH.dp, 48.dp)
        val stem = rule.node(ProjectListTags.TREE_STEM).bounds
        assertDp("stem drops from the avatar", project.top + 40.dp, stem.top)
        assertDp("stem centred on the avatar", 30, (stem.left + stem.right) / 2)
        val trunk = rule.node(ProjectListTags.TREE_TRUNK).bounds
        assertDp("last trunk stops at the elbow", worktree.top + 24.dp, trunk.bottom)
    }

    @Test
    fun oneChangedSessionRecomposesOnlyItsRow() {
        val compositions = HashMap<String, Int>()
        val sessions = listOf(cli("a"), cli("b", noon - 1), cli("c", noon - 2))
        var current by mutableStateOf(state(sessions))
        rule.setHappyContent {
            CompositionLocalProvider(LocalHomeRowObserver provides { id -> compositions[id] = (compositions[id] ?: 0) + 1 }) {
                HomeScreen(current, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions)
            }
        }
        rule.waitForIdle()
        assertEquals(mapOf("a" to 1, "b" to 1, "c" to 1), compositions)

        // b gets a draft: only b's row data differs.
        current = reuseUnchanged(current, state(sessions.map { if (it.id == "b") it.copy(draft = "wip") else it }))
        rule.waitForIdle()
        assertEquals(mapOf("a" to 1, "b" to 2, "c" to 1), compositions)
    }

    @Test
    fun snapshotsReadTheStoreWithPresenceOnTop() = runBlocking {
        val store = HappyStore(HappyDatabase(ApplicationProvider.getApplicationContext(), name = null))
        store.upsertSessions(
            listOf(
                SessionRecord(
                    id = "s1", seq = 1, createdAt = 1, updatedAt = 1, active = false, activeAt = 1,
                    metadataJson = """{"path":"/repo","host":"h"}""", metadataVersion = 1,
                    agentStateJson = null, agentStateVersion = 0, wrappedDataKey = "", projectId = null,
                ),
            ),
        )
        val presence = MutableStateFlow(mapOf("s1" to SessionPresence(active = true, activeAt = 9, thinking = true, thinkingAt = 9)))
        val snapshot = homeSnapshots(store, presence, MutableStateFlow(emptyMap())).first()
        val session = snapshot.sessions.single()
        assertTrue(session.active)
        assertTrue(session.thinking)
        assertEquals("/repo", session.metadata?.path)
        assertNull(snapshot.machines.firstOrNull())
        assertTrue(snapshot.ready)

        // Before the first sync, no machines is "not read yet", not "link a computer".
        assertFalse(homeSnapshots(store, presence, MutableStateFlow(emptyMap()), synced = flowOf(false)).first().ready)
    }
}
