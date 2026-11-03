package com.slopus.happy.ui.connection

import com.slopus.happy.ui.settings.SettingsTags
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.sp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.ui.components.avatar.AvatarPlaceholder
import com.slopus.happy.ui.components.avatar.PlaceholderIndexKey
import com.slopus.happy.agent.Wire
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** An agent connection's home: strict rows, subtasks, live updates, search over home. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentHomeLayoutTest {
    @get:Rule val rule = createComposeRule()

    private val opened = mutableListOf<String>()
    private var composed = 0
    private var composedWithPicture = 0
    private var settings = 0
    private val settingsRows = mutableListOf<AgentSettingsRow>()
    private var artifacts = 0
    private val surfaces = mutableListOf<AgentFeedRow.Surface>()
    private val actions = AgentHomeActions(
        onOpenConversation = { opened += it },
        onCompose = { composed++ },
        onComposeWithPicture = { composedWithPicture++ },
        onSettings = { settings++ },
        onSettingsRow = { settingsRows += it },
        onSwitchAccount = {},
        onAdd = {},
        onOpenArtifacts = { artifacts++ },
        onOpenSurface = { surfaces += it },
        onOpenArtifact = { openedArtifacts += it.id },
    )
    private val openedArtifacts = mutableListOf<String>()
    private val accounts = AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true)))

    companion object {
        const val NOW = 1_755_400_000_000L

        fun catalog(bootstrap: JsonObject) =
            AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap))

        /** A fixture: two Surfaces, a bot with a subtask, three tasks, and a project with a worktree. */
        val sample = Wire.bootstrap(
            surfaces = listOf(
                Wire.surface("s2", "Groceries", "todo", mapOf(Wire.USER to "2")),
                Wire.surface("s1", "Launch plan", "document", mapOf(Wire.USER to "1")),
                Wire.surface("s3", "Someone else's", "todo", mapOf("u2" to "1")),
            ),
            bots = listOf(
                Wire.bot("b1", "Happy", Wire.agent("ab1", updatedAt = NOW - 20 * 60_000, subtasks = listOf(Wire.agent("as1", title = "Review the PR", subtask = true, parent = "ab1", updatedAt = NOW - 5 * 60_000)))),
                Wire.bot("b2", "Research", Wire.agent("ab2", updatedAt = NOW - 3 * 3_600_000), orderKey = "2"),
            ),
            tasks = listOf(
                Wire.task("t1", "Fix login redirect", Wire.agent("at1", status = "running_tools", updatedAt = NOW - 60_000)),
                Wire.task("t2", "Write release notes", Wire.agent("at2", unread = true)),
                Wire.task("t3", "Plan the sprint", Wire.agent("at3", question = true)),
            ),
            memberships = listOf(Wire.membership("t1", "1"), Wire.membership("t2", "2"), Wire.membership("t3", "3")),
            projects = listOf(Wire.project("p1", "happy", listOf(Wire.agent("ap1", title = "Android home feed", updatedAt = NOW - 2 * 86_400_000)))),
            workspaces = listOf(Wire.workspace("w1", "p1", "fix-scroll", listOf(Wire.agent("aw1", title = "Scroll jumps", updatedAt = NOW - 9 * 86_400_000)))),
        )

        fun big(count: Int) = Wire.bootstrap(
            tasks = (0 until count).map { Wire.task("t$it", "Task number $it", Wire.agent("at$it")) },
            memberships = (0 until count).map { Wire.membership("t$it", "%04d".format(it)) },
        )
    }

    private fun feed(bootstrap: JsonObject = sample) = AgentFeed.derive(catalog(bootstrap))

    @Test
    fun countsStandBeforeTheStatusAndDoNotChangeRowHeight() {
        val changes = com.slopus.happy.agent.WorkspaceLineChanges("ready", 12345, 1234, false, 1.0)
        show(AgentFeed.derive(catalog(sample), git = mapOf("wat2" to changes)))
        val rowTag = AgentHomeTags.row("agent-at2")
        val counts = rule.onNode(hasTestTag(AgentHomeTags.ROW_CHANGES) and hasAnyAncestor(hasTestTag(rowTag)), useUnmergedTree = true).bounds
        val title = rule.onNode(hasTestTag(AgentHomeTags.ROW_TITLE) and hasAnyAncestor(hasTestTag(rowTag)), useUnmergedTree = true).bounds
        val dot = rule.onNode(hasTestTag(AgentHomeTags.ROW_DOT) and hasAnyAncestor(hasTestTag(rowTag)), useUnmergedTree = true).bounds
        assertTrue(title.right <= counts.left)
        assertTrue(counts.right <= dot.left)
        assertDp("unchanged row", 48, rule.node(rowTag).bounds.height)
        rule.onNodeWithContentDescription("≈ +12345 −1234", useUnmergedTree = true).assertExists()
    }

    @Test
    fun xHeightCountsShareTheActivityEdgeWithoutAnApproximationMark() {
        val changes = com.slopus.happy.agent.WorkspaceLineChanges("ready", 12345, 1234, false, 1.0)
        show(AgentFeed.derive(catalog(sample), git = mapOf("wat1" to changes)))
        val counts = rule.onNode(hasTestTag(AgentHomeTags.ROW_CHANGES), useUnmergedTree = true).bounds
        val dot = rule.onNode(hasTestTag(AgentHomeTags.ROW_DOT) and hasAnyAncestor(hasTestTag(AgentHomeTags.row("agent-at2"))), useUnmergedTree = true).bounds
        assertDp("counts and activity right edge", dot.right, counts.right)
        assertDp("stable line height", AgentHomeSpec.TITLE_LINE, counts.height)
        rule.onAllNodesWithText("≈", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun nativeDigitsMatchXHeightWithOneStableBaseline() {
        for (scale in listOf(1f, 1.3f, 2f)) {
            val metrics = AgentRowTypography(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.MONOSPACE, 17f * scale)
            val flat = AgentRowTypography.ink(metrics.countPaint, "1")
            assertEquals(metrics.xHeight, flat.height(), 0.01f)
            val height = (22 * scale).toInt()
            assertEquals(height / 2f, metrics.baseline(height) - metrics.xHeight / 2, 0.5f)
            assertTrue(metrics.countPaint.textSize < metrics.titlePaint.textSize)
            println("row typography scale=$scale title=${metrics.titlePaint.textSize} xHeight=${metrics.xHeight} counts=${metrics.countPaint.textSize} baseline=${metrics.baseline(height)}")
        }
    }

    private fun show(feed: AgentFeed, status: AgentLinkStatus = AgentLinkStatus.Connected, dark: Boolean = false) =
        rule.setHappyContent(dark) { AgentHomeScreen("Studio", feed, status, accounts, actions) }

    @Test
    fun rowsHaveTheirHeightAndNoComposer() {
        show(feed())
        val top = rule.node(AgentHomeTags.row("section-places")).bounds
        assertDp("room above the first card", 8, top.height)
        assertBox("artifacts row", rule.node(AgentHomeTags.row("artifacts")).bounds, 0.dp, top.bottom, 411.dp, 48.dp)
        val bots = rule.node(AgentHomeTags.row("section-bots")).bounds
        assertDp("the bots' card 24 after", 24, bots.height)
        val bot = rule.node(AgentHomeTags.row("agent-ab1")).bounds
        assertBox("bot row", bot, 0.dp, bots.bottom, 411.dp, 48.dp)
        rule.node(AgentHomeTags.row("agent-at1")).assertExists()
        assertDp("task row height", 48, rule.node(AgentHomeTags.row("agent-at1")).bounds.height)
        assertDp("folder row height", 48, rule.node(AgentHomeTags.row("folder-p1")).bounds.height)
        // No text field anywhere on home.
        rule.onAllNodesWithTag(AgentSearchTags.FIELD, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun theTopBarHasTheMenuAndNameLeftAndSearchSettingsRightAndComposeFloatsBottomEnd() {
        show(feed())
        val bar = rule.node(AgentHomeTags.BAR).bounds
        val menu = rule.node(AccountMenuTags.BUTTON).bounds
        assertTrue(menu.left < 30.dp)
        rule.onNodeWithTag(AgentHomeTags.BAR, useUnmergedTree = true).assertExists()
        val search = rule.node(AgentHomeTags.SEARCH).bounds
        val settingsButton = rule.node(AgentHomeTags.SETTINGS).bounds
        assertTrue(search.right <= settingsButton.left + 0.5.dp)
        // The bar's outer glyphs stand on the rows' content inside the cards, 32 in: the avatar's left, settings' 24 glyph's right.
        assertDp("the account avatar 32 in, on the rows' marks", 32, (menu.left + menu.right) / 2 - 16.dp)
        assertDp("the settings glyph ends 32 in, where the rows' content does", bar.right - 32.dp, (settingsButton.left + settingsButton.right) / 2 + 12.dp)
        // Every bar control takes a full 48 touch (Compose widens a smaller one's), and is drawn whole inside the bar.
        val tags = mapOf("menu" to AccountMenuTags.BUTTON, "search" to AgentHomeTags.SEARCH, "settings" to AgentHomeTags.SETTINGS)
        for ((label, rect) in listOf("menu" to menu, "search" to search, "settings" to settingsButton)) {
            val touch = rule.node(tags.getValue(label)).fetchSemanticsNode().touchBoundsInRoot
            val density = rule.density.density
            assertTrue("$label takes a 48 touch: $touch", touch.width / density >= 47.5f && touch.height / density >= 47.5f)
            assertTrue("$label is inside the bar", rect.left >= bar.left && rect.right <= bar.right && rect.top >= bar.top - 0.5.dp && rect.bottom <= bar.bottom + 0.5.dp)
        }
        // The title is the smaller bar title, not the 22sp headline.
        assertDp("title line", with(rule.density) { AgentHomeSpec.barTitle.lineHeight.toDp() }, rule.node(AgentHomeTags.TITLE).bounds.height)
        // Compose is a floating button, 16 in from the bottom end of the page.
        val compose = rule.node(AgentHomeTags.COMPOSE).bounds
        val list = rule.node(AgentHomeTags.LIST).bounds
        assertTrue("compose under the bar", compose.top > bar.bottom)
        assertDp("compose at the end", list.right - 16.dp, compose.right)
        assertDp("compose at the bottom", list.bottom - 16.dp, compose.bottom)
        assertDp("compose is a 56 FAB", 56, compose.width)
        // New work is "New task" (happy-ios 7a605f6ce).
        rule.onNodeWithContentDescription("New task", useUnmergedTree = true).assertExists()
        rule.node(AgentHomeTags.COMPOSE).performClick()
        rule.node(AgentHomeTags.SETTINGS).performClick()
        assertEquals(1, composed)
        assertEquals(1, settings)
    }

    @Test
    fun artifactsAndTheJoinedSurfacesOpenTheFirstCard() {
        show(feed())
        val rows = listOf("artifacts", "surface-s1", "surface-s2").map { rule.node(AgentHomeTags.row(it)).bounds }
        rows.zipWithNext().forEach { (a, b) -> assertDp("rows touch", a.bottom, b.top) }
        assertDp("the bots' card follows", rows.last().bottom, rule.node(AgentHomeTags.row("section-bots")).bounds.top)
        // Only the Surfaces the person joined, in their own order.
        rule.onAllNodesWithTag(AgentHomeTags.row("surface-s3"), useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("Artifacts", useUnmergedTree = true).assertExists()
        rule.node(AgentHomeTags.row("artifacts")).performClick()
        rule.node(AgentHomeTags.row("surface-s2")).performClick()
        assertEquals(1, artifacts)
        assertEquals(listOf(AgentFeedRow.Surface("s2", "Groceries", "todo")), surfaces)
        assertTrue(opened.isEmpty())
    }

    @Test
    fun theBarAndPageAreTheChatsSurface() {
        var surface = 0
        rule.setHappyContent(dark = true) {
            surface = com.slopus.happy.ui.theme.HappyTheme.colors.surface.toArgb()
            AgentHomeScreen("Studio", feed(), AgentLinkStatus.Connected, accounts, actions)
        }
        val bar = rule.node(AgentHomeTags.BAR).captureToImage().toPixelMap()
        // Glass over the page: its ground composites over the same colour and may round a step off it.
        val ground = bar[bar.width / 2, 4].toArgb()
        for (shift in listOf(16, 8, 0)) assertTrue((ground shr shift and 0xff) - (surface shr shift and 0xff) in -1..1)
        val list = rule.node(AgentHomeTags.LIST).captureToImage().toPixelMap()
        assertEquals(surface, list[list.width / 2, list.height - 4].toArgb())
    }

    @Test
    fun idleUpdatesMoveNoRow() {
        var current by mutableStateOf(feed())
        rule.setHappyContent { AgentHomeScreen("Studio", current, AgentLinkStatus.Connected, accounts, actions) }
        val before = listOf("agent-ab2", "agent-at1", "agent-at2", "agent-ap1").associateWith { rule.node(AgentHomeTags.row(it)).bounds }
        // Work starts and stops, results come in, a question is asked, a title is generated.
        var catalog = catalog(sample)
        catalog = catalog.apply(Wire.event("c1", "agent.updated", Wire.updated("agentId", "at1", "01", "02", buildJsonObject { put("status", "idle") }))).catalog
        catalog = catalog.apply(Wire.event("c2", "agent.updated", Wire.updated("agentId", "ab2", "01", "02", buildJsonObject { put("status", "thinking"); put("pendingQuestionId", "q") }))).catalog
        catalog = catalog.apply(Wire.event("c3", "agent.updated", Wire.updated("agentId", "ap1", "01", "02", buildJsonObject { put("title", "A much longer generated title that will not fit on one line at all") }))).catalog
        current = AgentFeed.derive(catalog)
        rule.waitForIdle()
        before.forEach { (key, rect) -> assertEquals(key, rect, rule.node(AgentHomeTags.row(key)).bounds) }
    }

    @Test
    fun everySubtaskShowsUnderItsParentAndNothingFolds() {
        show(feed())
        val parent = rule.node(AgentHomeTags.row("agent-ab1")).bounds
        val sub = rule.node(AgentHomeTags.row("agent-as1")).bounds
        assertDp("subtask under its parent", parent.bottom, sub.top)
        assertDp("subtask row height", 48, sub.height)
        rule.onAllNodesWithText("1", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun botsTasksAndProjectsWearAMarkAndSubtasksAndProjectConversationsNone() {
        show(feed())
        // Artifacts, the two Surfaces, the two bots, the three tasks and the project.
        rule.onAllNodesWithTag(AgentHomeTags.ROW_MARK, useUnmergedTree = true).assertCountEquals(9)
        val bot = rule.node(AgentHomeTags.row("agent-ab1")).bounds
        val mark = rule.onAllNodesWithTag(AgentHomeTags.ROW_MARK, useUnmergedTree = true)[3].bounds
        // The card 16 in from the window, the mark 16 in from the card.
        assertBox("bot mark", mark, 32.dp, bot.top + 9.dp, 30.dp, 30.dp)
        fun titleStart(title: String) = rule.onNodeWithText(title, useUnmergedTree = true).bounds.left
        assertDp("a bot's title follows its mark", 32 + 30 + 12, titleStart("Happy"))
        assertDp("a task's too", 32 + 30 + 12, titleStart("Fix login redirect"))
        assertDp("a subtask's starts under its parent's title", 32 + 42, titleStart("Review the PR"))
        assertDp("a project's title follows its mark", 32 + 30 + 12, titleStart("happy"))
        assertDp("its conversation a level in", 32 + 42, titleStart("Android home feed"))
        assertDp("a worktree a level in", 32 + 42, titleStart("fix-scroll"))
        assertDp("and its conversation two", 32 + 84, titleStart("Scroll jumps"))
        val task = rule.node(AgentHomeTags.row("agent-at1")).bounds
        val dividers = rule.onAllNodesWithTag(AgentHomeTags.ROW_DIVIDER, useUnmergedTree = true).fetchSemanticsNodes().map {
            with(rule.density) { it.boundsInRoot.left.toDp() to it.boundsInRoot.bottom.toDp() }
        }
        val under = dividers.single { (_, bottom) -> (bottom - task.bottom).value in -0.5f..0.5f }
        assertDp("the task's hairline runs from its title", 32 + 30 + 12, under.first)
    }

    @Test
    fun eachSectionIsOneUntitledCardOfSingleLineRows() {
        show(feed())
        val single = with(rule.density) { AgentHomeSpec.TITLE_LINE.sp.toDp() }
        val titles = rule.onAllNodesWithTag(AgentHomeTags.ROW_TITLE, useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue(titles.isNotEmpty())
        titles.forEach { assertDp("every title is one line", single, with(rule.density) { it.boundsInRoot.height.toDp() }) }
        // No section titles, and nothing said under a row's title.
        for (text in listOf("Bots", "Tasks", "Task", "Waiting for your answer")) rule.onAllNodesWithText(text, useUnmergedTree = true).assertCountEquals(0)
        // The tasks' card: 24 after the bots', three rows back to back, a hairline between each and none under the last.
        val gap = rule.node(AgentHomeTags.row("section-tasks")).bounds
        assertDp("cards stand 24 apart", 24, gap.height)
        assertDp("after the bots' last row", rule.node(AgentHomeTags.row("agent-ab2")).bounds.bottom, gap.top)
        val rows = listOf("agent-at1", "agent-at2", "agent-at3").map { rule.node(AgentHomeTags.row(it)).bounds }
        assertDp("the card starts after its gap", gap.bottom, rows[0].top)
        rows.zipWithNext().forEach { (a, b) -> assertDp("rows touch", a.bottom, b.top) }
        val dividers = rule.onAllNodesWithTag(AgentHomeTags.ROW_DIVIDER, useUnmergedTree = true).fetchSemanticsNodes()
            .map { with(rule.density) { it.boundsInRoot.bottom.toDp() } }
        rows.dropLast(1).forEach { row -> assertTrue(dividers.any { (it - row.bottom).value in -0.5f..0.5f }) }
        assertTrue(dividers.none { (it - rows.last().bottom).value in -0.5f..0.5f })
    }

    @Test
    fun aBotsPictureIsReadFromTheAgentOnce() {
        val read = mutableListOf<String>()
        val pictures = AgentPictures("agent-connection-1") { path -> read += path; ByteArray(0) }
        val bootstrap = Wire.bootstrap(
            bots = listOf(
                Wire.bot("b1", "Happy", Wire.agent("ab1"), thumbhash = "nvgJPJpwd3eAh4d3d4eAcAj4eA=="),
                Wire.bot("b2", "Research", Wire.agent("ab2"), orderKey = "2"),
            ),
        )
        rule.setHappyContent {
            CompositionLocalProvider(LocalAgentPictures provides pictures) {
                AgentHomeScreen("Studio", feed(bootstrap), AgentLinkStatus.Connected, accounts, actions)
            }
        }
        rule.waitForIdle()
        assertEquals(listOf("/v0/bots/b1/avatar"), read)
        // Artifacts' and the two bots'.
        rule.onAllNodesWithTag(AgentHomeTags.ROW_MARK, useUnmergedTree = true).assertCountEquals(3)
    }

    /** A bot without a picture, a task and a project without one wear the placeholder their own ids pick, as on happy-ios. */
    @Test
    fun marksWithoutAPictureAreTheirIdsPlaceholders() {
        show(feed())
        fun wears(rowKey: String): Int = rule.onNode(
            SemanticsMatcher.keyIsDefined(PlaceholderIndexKey) and hasAnyAncestor(hasTestTag(AgentHomeTags.row(rowKey))),
            useUnmergedTree = true,
        ).fetchSemanticsNode().config[PlaceholderIndexKey]
        assertEquals(AvatarPlaceholder.index("b1"), wears("agent-ab1"))
        assertEquals(AvatarPlaceholder.index("t2"), wears("agent-at2"))
        assertEquals(AvatarPlaceholder.index("p1"), wears("folder-p1"))
    }

    @Test
    fun aProjectsPictureIsReadToo() {
        val read = mutableListOf<String>()
        val pictures = AgentPictures("agent-connection-1") { path -> read += path; ByteArray(0) }
        val bootstrap = Wire.bootstrap(projects = listOf(Wire.project("p1", "happy", emptyList(), avatar = "image", thumbhash = "3OcRJYB4d3h3iIeHeEh3eIhw+j2w")))
        rule.setHappyContent {
            CompositionLocalProvider(LocalAgentPictures provides pictures) {
                AgentHomeScreen("Studio", feed(bootstrap), AgentLinkStatus.Connected, accounts, actions)
            }
        }
        rule.waitForIdle()
        assertEquals(listOf("/v0/projects/p1/avatar"), read)
    }

    @Test
    fun aRowAddedAboveKeepsTheReaderWhereTheyAre() {
        var current by mutableStateOf(feed(big(60)))
        rule.setHappyContent { AgentHomeScreen("Studio", current, AgentLinkStatus.Connected, accounts, actions) }
        rule.node(AgentHomeTags.LIST).performScrollToIndex(30)
        rule.waitForIdle()
        val anchor = rule.onAllNodesWithTag(AgentHomeTags.LIST, useUnmergedTree = true)[0]
        val before = rule.node(AgentHomeTags.row("agent-at30")).bounds
        // A new task joins at the top, and one far above changes.
        val catalog = catalog(big(60))
            .withTask(Wire.task("tn", "Brand new", Wire.agent("atn")))
            .apply(Wire.event("c1", "agent.updated", Wire.updated("agentId", "at2", "01", "02", buildJsonObject { put("status", "thinking") }))).catalog
        current = AgentFeed.derive(catalog)
        rule.waitForIdle()
        anchor.assertExists()
        assertEquals(before, rule.node(AgentHomeTags.row("agent-at30")).bounds)
    }

    @Test
    fun searchLiesOverHomeAndLeavesItWhereItWas() {
        show(feed(big(40)))
        rule.node(AgentHomeTags.LIST).performScrollToIndex(20)
        rule.waitForIdle()
        val row = rule.node(AgentHomeTags.row("agent-at20")).bounds
        val bar = rule.node(AgentHomeTags.BAR).bounds

        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.waitForIdle()
        assertEquals(bar, rule.node(AgentHomeTags.BAR).bounds)
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)
        val results = rule.node(AgentSearchTags.RESULTS).bounds
        assertDp("the results start under the bar", bar.bottom, results.top)

        rule.node(AgentSearchTags.FIELD).performTextInput("number 3")
        rule.waitForIdle()
        // Home's rows, drawn as home draws them: the grouped list's 8 under the bar.
        val found = rule.node(AgentSearchTags.result("agent-at3")).bounds
        assertBox("a found row", found, 0.dp, results.top + 8.dp, 411.dp, 48.dp)
        // Home stays composed under the results, rows and scroll as they were.
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)

        rule.node(AgentSearchTags.FIELD).performTextReplacement("zzzz")
        rule.waitForIdle()
        val none = rule.node(AgentSearchTags.NO_RESULTS)
        none.assertTextEquals("Nothing found")
        assertDp("nothing found stands 32 under where the results start", results.top + 32.dp, none.bounds.top)

        // What a result opens leaves the search as it was, for coming back.
        rule.node(AgentSearchTags.FIELD).performTextReplacement("number 3")
        rule.node(AgentSearchTags.result("agent-at3")).performClick()
        rule.waitForIdle()
        assertEquals(listOf("at3"), opened)
        rule.node(AgentSearchTags.FIELD).assertTextEquals("number 3")
        rule.node(AgentSearchTags.result("agent-at3")).assertExists()
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)
    }

    /**
     * iOS 50f34ed9f: rows keep their place through a width change. The
     * tablet shell swaps the phone's home for the sidebar's at 840, and the
     * sidebar leaves while hidden; either way home comes back where it was,
     * and another connection never opens on that place.
     */
    @Test
    fun homeComesBackWhereItWasAfterLeavingTheComposition() {
        val graph = com.slopus.happy.AppGraph(androidx.test.core.app.ApplicationProvider.getApplicationContext(), "android/test", "http://127.0.0.1:9", com.slopus.happy.testing.SoftwareKeys(), databaseName = null)
        var shown by mutableStateOf(true)
        var id by mutableStateOf("agent-connection-1")
        val many = feed(big(40))
        rule.setHappyContent {
            if (shown) AgentHomeScreen("Studio", many, AgentLinkStatus.Connected, accounts, actions, listState = rememberAgentHomeListState(graph, id))
        }
        rule.node(AgentHomeTags.LIST).performScrollToIndex(20)
        rule.waitForIdle()
        val row = rule.node(AgentHomeTags.row("agent-at20")).bounds
        shown = false
        rule.waitForIdle()
        shown = true
        rule.waitForIdle()
        assertEquals(row, rule.node(AgentHomeTags.row("agent-at20")).bounds)
        id = "agent-connection-2"
        rule.waitForIdle()
        rule.node(AgentHomeTags.row("artifacts")).assertExists()
    }

    /** iOS 8f745821b, 1a3b026a9: focused with nothing typed, the bots and tasks last active, with no title. */
    @Test
    fun anEmptySearchShowsTheBotsAndTasksLastActive() {
        show(feed())
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.waitForIdle()
        val tops = listOf("agent-at1", "agent-ab1", "agent-ab2", "agent-at2", "agent-at3").map { rule.node(AgentSearchTags.result(it)).bounds.top }
        assertEquals(tops.sorted(), tops)
        rule.onAllNodesWithTag(AgentSearchTags.result("agent-as1"), useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(AgentSearchTags.result("artifacts"), useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(AgentSearchTags.NO_RESULTS, useUnmergedTree = true).assertCountEquals(0)
    }

    /** HomeSearchPresentationLayout: pulled down from their top, the results close search when let go far enough, not short of it. */
    @Test
    fun aPullFromTheResultsTopClosesSearch() {
        show(feed())
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.waitForIdle()
        rule.node(AgentSearchTags.RESULTS).performTouchInput { swipeDown(startY = top + 20f, endY = top + 20f + 40.dp.toPx(), durationMillis = 1_000) }
        rule.waitForIdle()
        rule.node(AgentSearchTags.FIELD).assertExists()
        rule.node(AgentSearchTags.RESULTS).performTouchInput { swipeDown(startY = top + 20f, endY = top + 20f + 160.dp.toPx()) }
        rule.waitForIdle()
        rule.onAllNodesWithTag(AgentSearchTags.FIELD, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(AgentSearchTags.RESULTS, useUnmergedTree = true).assertCountEquals(0)
    }

    /** Search.rows: a nested match keeps what it nests under, the project and the worktree over a worktree's chat. */
    @Test
    fun aNestedMatchKeepsItsProjectAndWorktree() {
        show(feed())
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("jumps")
        rule.waitForIdle()
        val project = rule.node(AgentSearchTags.result("folder-p1")).bounds
        val chat = rule.node(AgentSearchTags.result("agent-aw1")).bounds
        assertTrue("the project over its worktree's chat", project.bottom < chat.top)
        rule.onAllNodesWithTag(AgentSearchTags.result("agent-ap1"), useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun searchFindsActionsAndSettings() {
        show(feed())
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("appear")
        rule.waitForIdle()
        rule.node(AgentSearchTags.result("entry-${AgentSettingsTags.APPEARANCE}")).assertExists()
        // happy-ios 7a605f6ce: "New task", and "New task with a picture" opening new work with "+"'s sheet up.
        rule.node(AgentSearchTags.FIELD).performTextReplacement("new task")
        rule.onNodeWithText("New task with a picture").assertExists()
        rule.node(AgentSearchTags.result("entry-new-work-picture")).performClick()
        assertEquals(1, composedWithPicture)
        // New work takes the screen, so the search gives it back first.
        rule.waitForIdle()
        rule.onAllNodesWithTag(AgentSearchTags.FIELD, useUnmergedTree = true).assertCountEquals(0)
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("new task")
        rule.node(AgentSearchTags.result("entry-new-work")).performClick()
        assertEquals(1, composed)
        rule.waitForIdle()
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("connect")
        rule.onNodeWithText("Connect Happy Agent").assertExists()
        rule.node(AgentSearchTags.FIELD).performTextReplacement("Settings")
        rule.node(AgentSearchTags.result("entry-settings")).performClick()
        assertEquals(1, settings)
        // Nothing that takes the connection away: as iOS's SettingsIndex, Disconnect isn't offered.
        rule.node(AgentSearchTags.FIELD).performTextReplacement("disconnect")
        rule.waitForIdle()
        rule.node(AgentSearchTags.NO_RESULTS).assertExists()
    }

    /**
     * Desktop's ⌘K sources (28342477) after home's rows: a Surface not
     * joined, an open todo and an artifact, each under its heading, read
     * while search is open; a todo opens its list, an artifact itself.
     */
    @Test
    fun searchFindsSurfacesTodosAndArtifactsAfterHomesRows() {
        var reads = 0
        val errands = AgentFeedRow.Surface("l2", "Errands", "todo")
        val sources = AgentSearchSources(
            surfaces = listOf(AgentSearchSources.Surface(AgentFeedRow.Surface("d2", "Plan for Q3", "document"), joined = false)),
            todos = listOf(AgentSearchSources.Todo("todo1", "Plan the offsite", errands)),
            artifacts = listOf(com.slopus.happy.artifacts.ArtifactRef("a1", 2, "html", "Sprint plan", followsLatest = true)),
        )
        rule.setHappyContent { AgentHomeScreen("Studio", feed(), AgentLinkStatus.Connected, accounts, actions, searchSources = { reads++; sources }) }
        assertEquals(0, reads)
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("plan")
        rule.waitForIdle()
        assertTrue(reads >= 1)
        for (heading in listOf("Documents", "Todos", "Artifacts")) {
            rule.onNode(androidx.compose.ui.test.hasText(heading) and androidx.compose.ui.test.hasAnyAncestor(androidx.compose.ui.test.hasTestTag(AgentSearchTags.RESULTS)), useUnmergedTree = true).assertExists()
        }
        val home = rule.node(AgentSearchTags.result("agent-at3")).bounds
        val document = rule.node(AgentSearchTags.result("surface-d2")).bounds
        val todo = rule.node(AgentSearchTags.result("todo-todo1")).bounds
        val artifact = rule.node(AgentSearchTags.result("artifact-a1")).bounds
        assertTrue(home.bottom < document.top && document.bottom < todo.top && todo.bottom < artifact.top)
        // iOS's rows: 48 high, as home's.
        for (row in listOf(document, todo, artifact)) assertDp("result row height", 48, row.height)
        rule.node(AgentSearchTags.result("todo-todo1")).performClick()
        assertEquals(listOf(errands), surfaces)
        rule.node(AgentSearchTags.result("artifact-a1")).performClick()
        assertEquals(listOf("a1"), openedArtifacts)
        // What a result opens leaves the search for coming back.
        rule.node(AgentSearchTags.FIELD).assertExists()
    }

    /**
     * iOS's home search over `SettingsIndex.computer`: the settings it
     * finds are the connection's settings rows, under Settings, and a tap
     * hands that row (its id and page) to be opened there.
     */
    @Test
    fun searchJumpsToASettingsRow() {
        show(feed())
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("hide")
        rule.waitForIdle()
        rule.onNodeWithText("Settings").assertExists()
        rule.node(AgentSearchTags.result("entry-${AgentPagesTags.HIDE_PROJECTS_ROW}")).performClick()
        rule.waitForIdle()
        assertEquals(listOf(AgentPagesTags.HIDE_PROJECTS_ROW to AgentSettingsPlace.Appearance), settingsRows.map { it.id to it.place })

        rule.node(AgentSearchTags.FIELD).performTextReplacement("privacy")
        rule.node(AgentSearchTags.result("entry-${SettingsTags.PRIVACY}")).performClick()
        rule.node(AgentSearchTags.FIELD).performTextReplacement("edit name")
        rule.node(AgentSearchTags.result("entry-${AgentSettingsTags.ASK_NAME}")).performClick()
        rule.waitForIdle()
        assertEquals(
            listOf(SettingsTags.PRIVACY to AgentSettingsPlace.Settings, AgentSettingsTags.ASK_NAME to AgentSettingsPlace.Ask),
            settingsRows.drop(1).map { it.id to it.place },
        )
        assertEquals("Change your name to ", settingsRows.last().ask)
        assertEquals(0, settings)
    }

    @Test
    fun theLinkDroppingAndComingBackMovesNothing() {
        val rows = feed()
        var status by mutableStateOf(AgentLinkStatus.Connected)
        rule.setHappyContent { AgentHomeScreen("Studio", rows, status, accounts, actions) }
        val bar = rule.node(AgentHomeTags.BAR).bounds
        val title = rule.node(AgentHomeTags.TITLE).bounds
        val first = rule.node(AgentHomeTags.row("section-places")).bounds
        // Online says nothing: the name stands alone.
        rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithText("online", useUnmergedTree = true).assertCountEquals(0)
        val flips = listOf(AgentLinkStatus.Connecting, AgentLinkStatus.Connected, AgentLinkStatus.Offline, AgentLinkStatus.Connecting, AgentLinkStatus.Connected)
        for (next in flips) {
            status = next
            rule.waitForIdle()
            assertEquals("bar, on $next", bar, rule.node(AgentHomeTags.BAR).bounds)
            // A computer that doesn't answer is said by the list's first row, which pushes the rows down (iOS ba0d7da0e).
            if (next == AgentLinkStatus.Offline) {
                val notice = rule.node(AgentHomeTags.BANNER).bounds
                rule.onNodeWithText("The computer did not answer.", useUnmergedTree = true).assertExists()
                val pushed = rule.node(AgentHomeTags.row("section-places")).bounds
                assertTrue("the notice above where the rows began", notice.top <= first.top)
                assertTrue("the rows pushed under it", pushed.top >= notice.bottom && pushed.top > first.top)
            } else {
                rule.onAllNodesWithTag(AgentHomeTags.BANNER, useUnmergedTree = true).assertCountEquals(0)
                assertEquals("first row, on $next", first, rule.node(AgentHomeTags.row("section-places")).bounds)
            }
            // Connecting stands in the name's place; offline keeps the name, which TalkBack hears offline after.
            if (next == AgentLinkStatus.Connecting) {
                rule.onAllNodesWithTag(AgentHomeTags.TITLE, useUnmergedTree = true).assertCountEquals(0)
                rule.node(AgentHomeTags.STATUS).assertExists()
                rule.onNodeWithText("Connecting…", useUnmergedTree = true).assertExists()
            } else {
                assertEquals("title, on $next", title, rule.node(AgentHomeTags.TITLE).bounds)
                rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true).assertCountEquals(0)
                rule.onAllNodes(hasStateDescription("offline"), useUnmergedTree = true)
                    .assertCountEquals(if (next == AgentLinkStatus.Offline) 1 else 0)
            }
        }
    }

    @Test
    fun loadingOfflineAndEmptyHaveTheirOwnPages() {
        var status by mutableStateOf(AgentLinkStatus.Connecting)
        var current by mutableStateOf(AgentFeed.Empty)
        rule.setHappyContent { AgentHomeScreen("Studio", current, status, accounts, actions) }
        rule.node(AgentHomeTags.SPINNER).assertExists()
        rule.node(AgentHomeTags.STATUS).assertExists()
        status = AgentLinkStatus.Offline
        rule.waitForIdle()
        rule.node(AgentHomeTags.OFFLINE).assertExists()
        // Offline with a cached home: the rows, and the name.
        current = feed()
        rule.waitForIdle()
        rule.node(AgentHomeTags.row("agent-ab1")).assertExists()
        rule.node(AgentHomeTags.TITLE).assertExists()
        rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true).assertCountEquals(0)
        rule.node(AgentHomeTags.BANNER).assertExists()
        rule.onNodeWithText("The computer did not answer.", useUnmergedTree = true).assertExists()
        status = AgentLinkStatus.Revoked
        rule.waitForIdle()
        rule.node(AgentHomeTags.BANNER).assertExists()
        status = AgentLinkStatus.Connected
        current = feed(Wire.bootstrap())
        rule.waitForIdle()
        rule.node(AgentHomeTags.EMPTY).assertExists()
        rule.onAllNodesWithTag(AgentHomeTags.STATUS, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun rowsGrowWithTheFontButStayFixed() {
        var row = 0.dp
        rule.setHappyContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                row = AgentHomeSpec.rowHeight()
                AgentHomeScreen("Studio", feed(), AgentLinkStatus.Connected, accounts, actions)
            }
        }
        // The line scales as Android 14 scales it (non-linearly); the paddings don't.
        assertTrue("taller than at 1.0", row > 56.dp)
        assertDp("conversation row", row, rule.node(AgentHomeTags.row("agent-ab1")).bounds.height)
        assertDp("folder row", row, rule.node(AgentHomeTags.row("folder-p1")).bounds.height)
    }
}
