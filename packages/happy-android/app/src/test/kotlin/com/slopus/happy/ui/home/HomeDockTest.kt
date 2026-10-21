package com.slopus.happy.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.ui.semantics.SemanticsProperties
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.StartPhase
import com.slopus.happy.model.resolveNewSessionOptions
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.TOLERANCE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.PickerSheetTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The home dock against HomeDock.tsx (Android branch):
 * - Resting: 16 either side, 8 above, 10 under it with no nav bar; the
 *   capsule 56 high, the text 21 in from its 7 padding ("Plan, ask,
 *   build…"); the 42 send button 7 from the capsule's end, centred. A tap
 *   on the text opens the composer; send works only with text.
 * - Focused, over the whole screen: MACHINE, PROJECT, WORKTREE and
 *   HARNESS rows 24 in, at least 42 high, 1 apart and 22 above the
 *   composer, which sits 16 in and 8 above the bottom: 10 in, the input
 *   at least 44 ("Ask Claude Code"), the 42 action row, the 42 primary
 *   button 10 in from the shell's edge, the model chip 10 before it; the
 *   42 add-image button at the action row's start, the permission 2 on.
 * - Images: their 64 thumbnails over the input, the composer 72 taller;
 *   images alone can be sent. A bot takes none: no button, no strip.
 * - A row opens its picker in place of the rows; a pick closes it.
 * - Starting: an 18 high line in the gap above the composer names the
 *   step with "To interrupt press stop"; the backdrop refuses; Stop hands
 *   the composer back. The backdrop otherwise closes it.
 * - The new-session screen is the same composer under a back header (a
 *   24 chevron-back in a 48 target, the title start-aligned after it). On
 *   an offline machine (new/index.tsx) the machine row is followed by the
 *   help: 12/10 in, a 14 cloud, "Machine is offline" 13 semibold 4 above
 *   the steps and "Switch machines" at 12/18; the rows under it fade to
 *   0.4 and take no presses. The dock itself shows no help.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeDockTest {
    @get:Rule
    val rule = createComposeRule()

    private val studio = machine("m1", machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true, codex = true) })
    private val air = machine("m2", machineMetadata(host = "air.local") { put("displayName", "Air"); cliAvailability(claude = true) }, active = false)
    private val machines = listOf(studio, air)
    private val sessions = listOf(session("a", metadata(path = "/Users/dev/code") { put("machineId", "m1") }, lastMessageSentAt = 1))

    private val focusChanges = mutableListOf<Boolean>()
    private val selections = mutableListOf<Pair<NewSessionPage, String>>()
    private val pickers = mutableListOf<NewSessionPage>()
    private var submits = 0
    private var addImages = 0
    private val removed = mutableListOf<String>()
    private var cancels = 0

    private val dockActions = HomeDockActions(
        onPromptChange = {},
        onFocusChange = { focusChanges += it },
        onSubmit = { submits++ },
        onCancel = { cancels++ },
        onSelect = { page, key -> selections += page to key },
        onOpenPicker = { pickers += it },
        onHarnessHelp = {},
        onAddImage = { addImages++ },
        onRemoveImage = { removed += it },
    )

    private val callbacks = HomeListCallbacks(
        onOpen = {}, onMenu = {}, onArchive = {}, onSetArchiveHidden = {}, onToggleProject = {},
        onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
    )
    private val actions = HomeScreenActions(
        onSettings = {}, onAppearance = {}, onSetGrouping = {}, onNewSession = {}, onTroubleshoot = {}, onOpenUrl = {}, onWhatsNew = {},
    )

    private fun dock(
        prompt: String = "",
        focused: Boolean = false,
        phase: StartPhase? = null,
        images: List<AttachmentPreview> = emptyList(),
        canAttachImages: Boolean = true,
        machineId: String = "m1",
    ) = HomeDockState(
        prompt = prompt,
        options = resolveNewSessionOptions(NewSessionDraft(selectedMachineId = machineId), machines, sessions, AgentDefaultOverrides()),
        labels = NewSessionLabels(),
        phase = phase,
        focused = focused,
        images = images,
        canAttachImages = canAttachImages,
    )

    private val image = AttachmentPreview("i1", "file:///nowhere/a.jpg", 10, 20, "image/jpeg", 100, "a.jpg")

    private fun show(dock: HomeDockState) {
        val list = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, machines), SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        rule.setHappyContent {
            HomeScreen(list, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions, dock = dock, dockActions = dockActions)
        }
    }

    private val rootBottom get() = rule.onRoot().bounds.bottom

    @Test
    fun theRestingCapsuleSitsOverTheBottomOfTheList() {
        show(dock())
        val capsule = rule.node(HomeDockTags.CAPSULE).bounds
        assertBox("capsule", capsule, 16.dp, rootBottom - 10.dp - 56.dp, (PHONE_WIDTH - 32).dp, 56.dp)
        assertDp("text 7 + 21 into the capsule", 16 + 7 + 21, rule.node(HomeDockTags.CAPSULE_TEXT).bounds.left)
        rule.onNodeWithText("Plan, ask, build…").assertIsDisplayed()
        val send = rule.node(HomeDockTags.CAPSULE_SEND).bounds
        assertBox("send", send, (PHONE_WIDTH - 16 - 7 - 42).dp, capsule.top + 7.dp, 42.dp, 42.dp)
        assertTrue("the list runs on under the dock", rule.node(HomeTags.LIST).bounds.bottom >= capsule.bottom - TOLERANCE)
    }

    @Test
    fun sendNeedsTextAndTheTextOpensTheComposer() {
        var state by mutableStateOf(dock())
        val list = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, machines), SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        rule.setHappyContent {
            HomeScreen(list, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions, dock = state, dockActions = dockActions)
        }
        rule.node(HomeDockTags.CAPSULE_SEND).performClick()
        assertEquals(0, submits)
        state = dock(prompt = "fix the build")
        rule.waitForIdle()
        rule.node(HomeDockTags.CAPSULE_SEND).performClick()
        assertEquals(1, submits)
        rule.node(HomeDockTags.CAPSULE_TEXT).performClick()
        assertEquals(listOf(true), focusChanges)
    }

    @Test
    fun theFocusedDockStacksItsRowsOverTheComposer() {
        show(dock(focused = true))
        rule.onAllNodesWithTag(HomeDockTags.CAPSULE, useUnmergedTree = true).assertCountEquals(0)
        val composer = rule.node(HomeDockTags.COMPOSER).bounds
        assertBox("composer", composer, 16.dp, composer.top, (PHONE_WIDTH - 32).dp, composer.bottom - composer.top)
        assertDp("8 above the bottom", rootBottom - 8.dp, composer.bottom)
        assertDp("an empty composer: 8 + 44 + 42 + 8", 102, composer.bottom - composer.top)

        val rows = NewSessionPage.entries.take(4).map { rule.node(HomeDockTags.row(it)).bounds }
        rows.forEach { row ->
            assertDp("row 24 in", 24, row.left)
            assertDp("row width", PHONE_WIDTH - 48, row.right - row.left)
            assertTrue("row at least 42", row.bottom - row.top >= 42.dp - TOLERANCE)
        }
        rows.zipWithNext().forEach { (above, below) -> assertDp("1 apart", 1, below.top - above.bottom) }
        assertDp("22 above the composer", composer.top - 22.dp, rows.last().bottom)
        rule.onNodeWithText("Studio").assertIsDisplayed()
        rule.onNodeWithText("Claude Code").assertIsDisplayed()

        val input = rule.node(HomeDockTags.INPUT).bounds
        assertDp("input 10 + 8 in", 16 + 10 + 8, input.left)
        rule.onNodeWithText("Ask Claude Code").assertIsDisplayed()
        val actionRow = rule.node(HomeDockTags.ACTION_ROW).bounds
        assertDp("action row", 42, actionRow.bottom - actionRow.top)
        val primary = rule.node(HomeDockTags.PRIMARY).bounds
        assertBox("primary", primary, (PHONE_WIDTH - 16 - 10 - 42).dp, actionRow.top, 42.dp, 42.dp)
        val effort = rule.node(HomeDockTags.EFFORT).bounds
        assertDp("effort 10 before send", primary.left - 10.dp, effort.right)
        assertTrue("effort at least 64", effort.right - effort.left >= 64.dp - TOLERANCE)
        assertTrue("model before effort", rule.node(HomeDockTags.MODEL).bounds.right < effort.left)
        val add = rule.node(HomeDockTags.ADD_IMAGE).bounds
        assertBox("add image at the row's start", add, (16 + 10).dp, actionRow.top, 42.dp, 42.dp)
        assertDp("permission 2 after it", add.right + 2.dp, rule.node(HomeDockTags.PERMISSION).bounds.left)
        assertDp("chips 40 high", 40, rule.node(HomeDockTags.MODEL).bounds.let { it.bottom - it.top })
    }

    @Test
    fun picturesRideAboveTheInputAndSendWithoutText() {
        show(dock(focused = true, images = listOf(image)))
        val composer = rule.node(HomeDockTags.COMPOSER).bounds
        assertDp("the composer grows by 72", 102 + 72, composer.bottom - composer.top)
        val thumb = rule.node(AttachmentStripTags.THUMB).bounds
        assertBox("thumbnail 8 + 4 into the composer's 10, under its 8", thumb, (16 + 10 + 8 + 4).dp, composer.top + 8.dp, 64.dp, 64.dp)
        // The input's 44 box starts 8 under the thumbnails; one 22 line sits centred in it.
        assertDp("the input's box 8 under the thumbnails", thumb.bottom + 8.dp + 11.dp, rule.node(HomeDockTags.INPUT).bounds.top)
        rule.node(HomeDockTags.PRIMARY).assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Send")))
        rule.node(HomeDockTags.PRIMARY).performClick()
        assertEquals("images alone can be sent", 1, submits)
        rule.node(HomeDockTags.ADD_IMAGE).performClick()
        assertEquals(1, addImages)
        rule.node(AttachmentStripTags.REMOVE).performClick()
        assertEquals(listOf("i1"), removed)
    }

    @Test
    fun aBotTakesNoPictures() {
        show(dock(focused = true, images = listOf(image), canAttachImages = false))
        rule.onAllNodesWithTag(HomeDockTags.ADD_IMAGE, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(AttachmentStripTags.STRIP, useUnmergedTree = true).assertCountEquals(0)
        rule.node(HomeDockTags.PRIMARY).performClick()
        assertEquals("nothing to send", 0, submits)
    }

    @Test
    fun aRowOpensItsPickerInPlaceOfTheRows() {
        show(dock(focused = true))
        rule.node(HomeDockTags.row(NewSessionPage.Machine)).performClick()
        assertEquals(listOf(NewSessionPage.Machine), pickers)
        rule.onAllNodesWithTag(HomeDockTags.ROWS, useUnmergedTree = true).assertCountEquals(0)
        rule.node(PickerSheetTags.TITLE).assertIsDisplayed()
        val panel = rule.node(PickerSheetTags.PANEL).bounds
        assertDp("panel 24 in", 24, panel.left)
        assertDp("22 above the composer", rule.node(HomeDockTags.COMPOSER).bounds.top - 22.dp, panel.bottom)
        val option = rule.node(PickerSheetTags.option("m2")).bounds
        assertTrue("an option at least 56", option.bottom - option.top >= 56.dp - TOLERANCE)
        rule.node(PickerSheetTags.option("m2")).performClick()
        assertEquals(listOf(NewSessionPage.Machine to "m2"), selections)
        rule.node(HomeDockTags.ROWS).assertIsDisplayed()

        rule.node(HomeDockTags.MODEL).performClick()
        rule.node(PickerSheetTags.option("claude-opus-5-5")).assertIsDisplayed()
        rule.node(PickerSheetTags.CLOSE).performClick()
        rule.node(HomeDockTags.ROWS).assertIsDisplayed()
        assertTrue(selections.size == 1)
    }

    @Test
    fun whileStartingTheStepShowsAndOnlyStopLeaves() {
        show(dock(prompt = "fix", focused = true, phase = StartPhase.Spawning))
        val composer = rule.node(HomeDockTags.COMPOSER).bounds
        val line = rule.node(HomeDockTags.PROGRESS).bounds
        assertBox("progress line", line, 16.dp, composer.top - 18.dp, (PHONE_WIDTH - 32).dp, 18.dp)
        rule.onNodeWithText("Starting Claude Code…").assertIsDisplayed()
        rule.node(HomeDockTags.PROGRESS_HINT).assertIsDisplayed()
        assertDp("the hint ends 16 in", line.right - 16.dp, rule.node(HomeDockTags.PROGRESS_HINT).bounds.right)

        rule.node(HomeDockTags.BACKDROP).performClick()
        rule.node(HomeDockTags.row(NewSessionPage.Project)).performClick()
        assertTrue("refused", focusChanges.isEmpty() && pickers.isEmpty())

        rule.node(HomeDockTags.PRIMARY).assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Stop")))
        rule.node(HomeDockTags.PRIMARY).performClick()
        assertEquals(1, cancels)
        // After closeFocusMode's 180 ms.
        rule.waitForIdle()
        assertEquals(listOf(false), focusChanges)
    }

    @Test
    fun theBackdropClosesTheComposer() {
        show(dock(focused = true))
        rule.node(HomeDockTags.BACKDROP).performClick()
        rule.waitForIdle()
        assertEquals(listOf(false), focusChanges)
    }

    @Test
    fun theNewSessionScreenIsTheComposerUnderABackHeader() {
        var backs = 0
        rule.setHappyContent {
            NewSessionScreen(NewSessionDock(dock(focused = true), dockActions) {}, onBack = { backs++ })
        }
        rule.onNodeWithText("Start New Session").assertIsDisplayed()
        val header = rule.node(HeaderTags.BAR).bounds
        // new/index.tsx's header: a 24 chevron-back in a 48 target 16 in, the title start-aligned 8 after it.
        val back = rule.node(NewSessionTags.BACK).bounds
        assertBox("back", back, 16.dp, back.top, 48.dp, 48.dp)
        assertDp("title after the back", 16 + 48 + 8, rule.node(NewSessionTags.TITLE).bounds.left)
        rule.node(NewSessionTags.BACK).performClick()
        assertEquals(1, backs)
        backs = 0
        val rows = rule.node(HomeDockTags.ROWS).bounds
        assertTrue("rows under the header", rows.top >= header.bottom)
        assertDp("composer 8 above the bottom", rootBottom - 8.dp, rule.node(HomeDockTags.COMPOSER).bounds.bottom)
        // Nothing dims, and a tap beside the composer does not leave.
        rule.node(HomeDockTags.BACKDROP).performClick()
        assertTrue(focusChanges.isEmpty())
        assertEquals(0, backs)
        rule.onAllNodesWithTag(HomeDockTags.OFFLINE_HELP).assertCountEquals(0)
    }

    @Test
    fun theNewSessionScreenExplainsAnOfflineMachine() {
        rule.setHappyContent {
            NewSessionScreen(NewSessionDock(dock(focused = true, machineId = "m2"), dockActions) {}, onBack = {})
        }
        val machine = rule.node(HomeDockTags.row(NewSessionPage.Machine)).bounds
        val help = rule.node(HomeDockTags.OFFLINE_HELP).bounds
        val project = rule.node(HomeDockTags.row(NewSessionPage.Project)).bounds
        assertTrue("help under the machine row", help.top >= machine.bottom - TOLERANCE)
        assertTrue("the other rows under the help", project.top >= help.bottom - TOLERANCE)
        assertDp("help with the rows, 24 in", 24, help.left)
        assertDp("title after 12 + the 14 cloud + 8", 24 + 12 + 14 + 8, rule.onNodeWithText("Machine is offline", useUnmergedTree = true).bounds.left)
        rule.onNodeWithText("Switch machines", substring = true, useUnmergedTree = true).assertExists()
        rule.onNodeWithText("happy daemon start", substring = true, useUnmergedTree = true).assertExists()
        // Only another machine helps: the rows under it take no presses.
        rule.node(HomeDockTags.row(NewSessionPage.Project)).assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Disabled))
        rule.node(HomeDockTags.row(NewSessionPage.Project)).performClick()
        rule.node(HomeDockTags.row(NewSessionPage.Agent)).performClick()
        assertTrue(pickers.isEmpty())
        rule.node(HomeDockTags.row(NewSessionPage.Machine)).performClick()
        assertEquals(listOf(NewSessionPage.Machine), pickers)
    }

    @Test
    fun theDockLeavesAnOfflineMachineToSend() {
        show(dock(focused = true, machineId = "m2"))
        rule.node(HomeDockTags.ROWS).assertIsDisplayed()
        rule.onAllNodesWithTag(HomeDockTags.OFFLINE_HELP).assertCountEquals(0)
        rule.node(HomeDockTags.row(NewSessionPage.Project)).performClick()
        assertEquals(listOf(NewSessionPage.Project), pickers)
    }
}
