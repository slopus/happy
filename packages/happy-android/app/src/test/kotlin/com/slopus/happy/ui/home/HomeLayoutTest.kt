package com.slopus.happy.ui.home

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
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
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
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.HomeCardTags
import com.slopus.happy.ui.connection.AgentHomeSpec
import kotlinx.serialization.json.buildJsonObject
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
 * The phone home screen, as iOS's legacy home draws it now and as the
 * agent connection's home does:
 * - The bar: the account menu on the left, the account's name (the smaller
 *   bar title) with how the connection stands after it while it isn't
 *   online, settings at the end. Compose is a 56 floating button 16 in from
 *   the bottom end, in every state but loading and the link state.
 * - The rows stand in inset cards 16 in from the sides, from 8 under the
 *   bar: a card row of the flat list is 81 (40 avatar at the card's 16, 12
 *   to the text, title 17/22, project 15/20, 1, the workspace line's 18),
 *   with a 10 dot and no time; hairlines from the text to the card's edge,
 *   none under a card's last row. Swiping uncovers a 112 Archive action; a
 *   long press opens the session menu.
 * - The archive toggle stands on the page between the live card and the
 *   archive's, with no day headings.
 * - ProjectHomeList: 52 project rows with a 28 avatar, 48 worktrees, in one
 *   card; a single computer heads nothing.
 * - SessionsListWrapper: spinner while loading, EmptyMainScreen's states.
 * - One changed session recomposes its own row and no other; nothing a row
 *   shows changes its height.
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
    private var composed = 0
    private var settings = 0
    private var whatsNew = 0
    private var linkComputer = 0
    private val actions = HomeScreenActions(
        onSettings = { settings++ },
        onNewSession = { newSession++ },
        onTroubleshoot = {},
        onOpenUrl = {},
        onWhatsNew = { whatsNew++ },
        onLinkComputer = { linkComputer++ },
        onCompose = { composed++ },
    )
    private val accounts = AccountMenu(listOf(AccountMenuEntry("acc", "Steve", active = true)))

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
            HomeScreen(state, status, state?.grouping ?: SessionListGrouping.Flat, callbacks, actions, accounts = accounts)
        }
    }

    private val barBottom get() = rule.node(HomeTags.BAR).bounds.bottom

    @Test
    fun theBarIsTheAgentHomesAndComposeFloatsBottomEnd() {
        show(state(listOf(cli("a"))))
        val bar = rule.node(HomeTags.BAR).bounds
        val menu = rule.node(AccountMenuTags.BUTTON).bounds
        assertTrue("the account menu at the start", menu.left < 30.dp)
        assertDp("account menu centred in the bar", (bar.top + bar.bottom) / 2, (menu.top + menu.bottom) / 2)
        val settingsButton = rule.node(HomeTags.SETTINGS).bounds
        // The bar's outer glyphs stand on the rows' content inside the cards: the avatar's left on the first row's, settings' 24 glyph's right where the rows' content ends.
        val rowAvatar = rule.onAllNodesWithTag(FlatRowTags.AVATAR, useUnmergedTree = true)[0].getUnclippedBoundsInRoot()
        val rowEnd = rule.onAllNodesWithTag(FlatRowTags.TOP_RIGHT, useUnmergedTree = true)[0].getUnclippedBoundsInRoot()
        assertDp("the row's avatar 32 in", 32, rowAvatar.left)
        assertDp("the account avatar on the row's", rowAvatar.left, (menu.left + menu.right) / 2 - 16.dp)
        assertDp("the row's content ends 32 in", bar.right - 32.dp, rowEnd.right)
        assertDp("the settings glyph ends with the row's content", rowEnd.right, (settingsButton.left + settingsButton.right) / 2 + 12.dp)
        // The account's name, the smaller bar title; online says nothing.
        rule.onNodeWithText("Steve", useUnmergedTree = true).assertExists()
        assertDp("title line", with(rule.density) { AgentHomeSpec.barTitle.lineHeight.toDp() }, rule.node(HomeTags.TITLE).bounds.height())
        rule.onAllNodesWithTag(HomeTags.STATUS, useUnmergedTree = true).assertCountEquals(0)
        val compose = rule.node(HomeTags.COMPOSE).bounds
        val list = rule.node(HomeTags.LIST).bounds
        assertDp("compose at the end", list.right - 16.dp, compose.right)
        assertDp("compose at the bottom", list.bottom - 16.dp, compose.bottom)
        assertDp("compose is a 56 FAB", 56, compose.right - compose.left)
        rule.node(HomeTags.COMPOSE).performClick()
        rule.node(HomeTags.SETTINGS).performClick()
        assertEquals(1, composed)
        assertEquals(1, settings)
        assertEquals("compose is not the new-session screen", 0, newSession)
    }

    @Test
    fun anUnhealthyConnectionFollowsTheName() {
        show(state(listOf(cli("a"))), ConnectionStatus.DISCONNECTED)
        val bar = rule.node(HomeTags.BAR).bounds
        val title = rule.node(HomeTags.TITLE).bounds
        val status = rule.node(HomeTags.STATUS).bounds
        assertDp("status centred in the bar", (bar.top + bar.bottom) / 2, (status.top + status.bottom) / 2)
        assertTrue("status after the name", status.left >= title.right)
        rule.onNodeWithText("offline", useUnmergedTree = true).assertExists()
    }

    @Test
    fun theConnectionChangingMovesNeitherTheNameNorTheRows() {
        val home = state(listOf(cli("a")))
        var connection by mutableStateOf(ConnectionStatus.CONNECTED)
        var syncing by mutableStateOf(false)
        rule.setHappyContent {
            HomeScreen(home, connection, home.grouping, callbacks, actions, accounts = accounts, syncing = syncing)
        }
        val first = rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)[0].bounds
        val title = rule.node(HomeTags.TITLE).bounds
        for ((status, catchingUp) in listOf(
            ConnectionStatus.CONNECTING to false, ConnectionStatus.CONNECTED to true,
            ConnectionStatus.CONNECTED to false, ConnectionStatus.DISCONNECTED to false,
            ConnectionStatus.ERROR to false, ConnectionStatus.CONNECTING to true,
            ConnectionStatus.CONNECTED to true, ConnectionStatus.CONNECTED to false,
        )) {
            connection = status
            syncing = catchingUp
            rule.waitForIdle()
            assertEquals(first, rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)[0].bounds)
            assertEquals(title, rule.node(HomeTags.TITLE).bounds)
            val label = when (status) {
                ConnectionStatus.CONNECTED -> if (catchingUp) "syncing" else null
                ConnectionStatus.CONNECTING -> "connecting"
                else -> "offline"
            }
            rule.onAllNodesWithTag(HomeTags.STATUS, useUnmergedTree = true).assertCountEquals(if (label == null) 0 else 1)
            if (label != null) rule.onNodeWithText(label, useUnmergedTree = true).assertExists()
        }
    }

    @Test
    fun flatRowsStandInACard() {
        show(state(listOf(cli("a"), cli("b", noon - 1))))
        val rows = rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)
        rows.assertCountEquals(2)
        val row = rows[0].bounds
        assertBox("first row, in its card", row, 16.dp, barBottom + GlassSpec.feather + 8.dp, (PHONE_WIDTH - 32).dp, 81.dp)
        val avatar = rule.onAllNodesWithTag(FlatRowTags.AVATAR, useUnmergedTree = true)[0].bounds
        assertBox("avatar", avatar, 32.dp, row.top + 20.5.dp, 40.dp, 40.dp)
        val title = rule.onAllNodesWithTag(FlatRowTags.TITLE, useUnmergedTree = true)[0].bounds
        assertDp("title left", 84, title.left)
        assertDp("title top", row.top + 10.dp, title.top)
        assertDp("title line", 22, title.bottom - title.top)
        val corner = rule.onAllNodesWithTag(FlatRowTags.TOP_RIGHT, useUnmergedTree = true)[0].bounds
        assertDp("corner ends 16 into the card", (PHONE_WIDTH - 32).dp, corner.right)
        assertDp("corner holds only the 10 dot", 10, corner.right - corner.left)
        assertDp("corner 8 after the title", title.right + 8.dp, corner.left)
        val project = rule.onAllNodesWithTag(FlatRowTags.PROJECT, useUnmergedTree = true)[0].bounds
        assertDp("project under the title", title.bottom, project.top)
        assertDp("project line", 20, project.bottom - project.top)
        // The card draws one hairline, under the first row from its text to the card's edge; none under the last.
        rule.onAllNodesWithTag(FlatRowTags.DIVIDER, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(HomeCardTags.DIVIDER, useUnmergedTree = true).assertCountEquals(1)
        val divider = rule.node(HomeCardTags.DIVIDER).bounds
        assertBox("divider", divider, 84.dp, row.bottom - divider.height(), (PHONE_WIDTH - 84 - 16).dp, divider.height())
        assertBox("second row", rows[1].bounds, 16.dp, row.bottom, (PHONE_WIDTH - 32).dp, 81.dp)
        // No times on home's rows.
        rule.onAllNodesWithText("12:00 PM", substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    /** A row's height is its kind's, whatever it shows: a workspace or not, a dot or not, a title too long for its line. */
    @Test
    fun nothingARowShowsChangesItsHeight() {
        val plain = cli("plain")
        val busy = session(
            "busy",
            metadata = metadata(path = "/Users/dev/busy") {
                put("machineId", "m1")
                put("summary", buildJsonObject { put("text", "A generated title much too long to fit on its one line in the card"); put("updatedAt", 1) })
                put("workspace", buildJsonObject { put("id", "w"); put("kind", "workspace"); put("name", "fix-scroll") })
            },
            active = true,
            lastMessageSentAt = noon - 1,
        )
        show(state(listOf(plain, busy), unread = setOf("busy")))
        rule.onAllNodesWithTag(FlatRowTags.DOT, useUnmergedTree = true).assertCountEquals(1)
        val rows = rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)
        assertDp("plain", 81, rows[0].bounds.height())
        assertDp("workspace, unread, long title", 81, rows[1].bounds.height())
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
        assertBox("archive action, at the card's end", action, (PHONE_WIDTH - 16 - 112).dp, row.top, 112.dp, 81.dp)
        assertDp("row slid by the action's width", 16 - 112, row.left)
        rule.node(FlatRowTags.ARCHIVE_ACTION).performClick()
        assertEquals(listOf("a"), archived)
    }

    @Test
    fun theArchiveIsOneCardUnderItsToggle() {
        show(state(listOf(cli("a"), cli("gone", noon, active = false), cli("older", noon - 3 * 86_400_000L, active = false)), hidden = false))
        val rows = rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true)
        val lastLive = rows[0].bounds
        val toggle = rule.node(HomeTags.ARCHIVE_TOGGLE).bounds
        assertDp("toggle right under the live card", lastLive.bottom, toggle.top)
        // Two days, no headings: the archive is one card under the toggle.
        rule.onAllNodesWithTag(HomeTags.DAY_HEADER, useUnmergedTree = true).assertCountEquals(0)
        assertDp("the archive's card under the toggle", toggle.bottom, rows[1].bounds.top)
        assertDp("one card", rows[1].bounds.bottom, rows[2].bounds.top)
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
            HomeScreen(current, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions, update = HomeUpdate.Changelog, accounts = accounts)
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
                offlineContent = { computers, _ -> offlineComputers = computers },
            )
        }
        rule.node(HomeTags.LOADING).assertExists()

        current = state(emptyList())
        rule.waitForIdle()
        assertEquals(HomeEmptyState.NoSessions, current!!.emptyState)
        rule.node(HomeStateTags.NO_SESSIONS).assertExists()
        rule.node(HomeStateTags.NEW_SESSION).performClick()
        assertEquals("the empty home's button composes", 1, composed)
        rule.node(HomeTags.COMPOSE).assertExists()

        current = state(emptyList(), machines = listOf(studio.copy(active = false)))
        rule.waitForIdle()
        assertEquals(listOf("Studio"), offlineComputers)

        // No computer and nothing to list: the link state is home's empty state, under home's own
        // header. The account menu and Settings stay reachable; there is nothing to compose on yet.
        // Scan QR code starts the scan.
        current = state(emptyList(), machines = emptyList())
        rule.waitForIdle()
        assertEquals(HomeEmptyState.Link, current!!.emptyState)
        rule.node(HomeTags.LINK).assertExists()
        rule.node(AccountMenuTags.BUTTON).assertExists()
        rule.node(HomeTags.SETTINGS).assertExists()
        rule.onAllNodesWithTag(HomeTags.COMPOSE, useUnmergedTree = true).assertCountEquals(0)
        assertTrue("link state under the header", rule.node(HomeTags.LINK).bounds.top >= rule.node(HomeTags.SETTINGS).bounds.bottom)
        rule.onNodeWithText("Scan QR code").performClick()
        assertEquals(1, linkComputer)

        // Sessions cached with no computer linked still list; the link state is only for an empty home.
        current = state(listOf(cli("a")), machines = emptyList())
        rule.waitForIdle()
        rule.node(FlatRowTags.ROW).assertExists()
        rule.onAllNodesWithTag(HomeTags.LINK, useUnmergedTree = true).assertCountEquals(0)
    }

    /**
     * TalkBack over Home, as MainView, FlatSessionRow and SessionsList label
     * it: the account menu, Settings and New chat are named buttons; an
     * unread row's corner reads "new results", a read one's says nothing;
     * the archive toggle is a button, selected while the archive shows.
     * Grouped by project, every row is a button.
     */
    @Test
    fun homeReadsForTalkBack() {
        show(state(listOf(cli("a"), cli("gone", noon, active = false)), hidden = false, unread = setOf("a")))
        rule.onNode(hasContentDescription("Accounts", substring = true) and hasRole(Role.Button), useUnmergedTree = true).assertExists()
        rule.onNode(hasContentDescription("New chat") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasContentDescription("Settings") and hasRole(Role.Button)).assertExists()
        rule.onAllNodesWithTag(FlatRowTags.TOP_RIGHT, useUnmergedTree = true)[0].assert(hasContentDescription("new results"))
        rule.onAllNodesWithTag(FlatRowTags.TOP_RIGHT, useUnmergedTree = true)[1].assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ContentDescription))
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
        // One computer heads nothing, and the projects' section heading is no more than the room above its card.
        rule.onAllNodesWithTag(ProjectListTags.MACHINE, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(ProjectListTags.SECTION, useUnmergedTree = true).assertCountEquals(0)
        val project = rule.node(ProjectListTags.PROJECT).bounds
        assertBox("project row, in its card", project, 16.dp, barBottom + GlassSpec.feather + 8.dp, (PHONE_WIDTH - 32).dp, 52.dp)
        val worktree = rule.node(ProjectListTags.WORKTREE).bounds
        assertBox("worktree, in the same card", worktree, 16.dp, project.bottom, (PHONE_WIDTH - 32).dp, 48.dp)
        val stem = rule.node(ProjectListTags.TREE_STEM).bounds
        assertDp("stem drops from the avatar", project.top + 40.dp, stem.top)
        assertDp("stem centred on the avatar", 16 + 16 + 14, (stem.left + stem.right) / 2)
        val trunk = rule.node(ProjectListTags.TREE_TRUNK).bounds
        assertDp("last trunk stops at the elbow", worktree.top + 24.dp, trunk.bottom)
        // The tree line joins them already: no hairline between.
        rule.onAllNodesWithTag(HomeCardTags.DIVIDER, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun twoComputersEachHeadTheirCards() {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        val laptop = machine("m2", machineMetadata { put("displayName", "Laptop") })
        val sessions = listOf(
            session("own", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
            session("cli", metadata = metadata(path = "/Users/dev/site") { put("machineId", "m2") }, active = true, lastMessageSentAt = noon - 1),
        )
        show(state(sessions, grouping = SessionListGrouping.Project, machines = listOf(rig, laptop)))
        val headings = rule.onAllNodesWithTag(ProjectListTags.MACHINE, useUnmergedTree = true)
        headings.assertCountEquals(2)
        val first = headings[0].bounds
        val project = rule.onAllNodesWithTag(ProjectListTags.PROJECT, useUnmergedTree = true)[0].bounds
        assertDp("the heading's glyph in line with the cards' avatars", 32, rule.onNodeWithText("Studio", useUnmergedTree = true).bounds.left - 12.dp - 6.dp)
        assertDp("the card 8 under its heading", first.bottom, project.top)
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
