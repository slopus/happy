package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.model.ComposeKind
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposeChatTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.NewWorkTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.tablet.TabletShellTags
import com.slopus.happy.ui.tablet.TabletSidebarTags
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Compose's empty chat: Back before a slow computer has answered stops the
 * start, and the text stays in the draft for the next compose; the computer
 * and folder are asked in its middle, the computer only with two; on a
 * tablet it opens in the detail pane and becomes the chat in place there.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposeJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server

    @After
    fun tearDown() = journey.close()

    @Test
    fun leavingBeforeTheComputerAnswersStopsTheStartAndKeepsTheText() {
        journey.machine()
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        // The computer never answers.
        server.silentRpc += "${Journey.MACHINE}:spawn-happy-session"
        val graph = journey.graph()
        journey.signIn(graph)
        val newSession = HomeServices.of(graph).newSession(ApplicationProvider.getApplicationContext())
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)

        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(ComposeChatTags.TARGET)
        rule.node(ComposerTags.INPUT).performTextInput("Plan the release")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntil(10_000) { newSession.starter.phase.value != null }

        rule.node(HeaderTags.LEFT).performClick()
        rule.waitUntilDoesNotExist(hasTestTag(ComposeChatTags.TARGET), 5_000)
        rule.waitFor(HomeTags.COMPOSE)
        rule.waitUntil(5_000) { newSession.starter.phase.value == null }
        assertEquals("Plan the release", newSession.draft.value.input)

        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(ComposeChatTags.TARGET)
        rule.node(ComposerTags.INPUT).assertTextEquals("Plan the release")
    }

    @Test
    fun theComputerIsAlwaysAskedWithItsStatusAndTheFoldersFollowIt() {
        journey.machine()
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        val graph = journey.graph()
        journey.signIn(graph)
        val newSession = HomeServices.of(graph).newSession(ApplicationProvider.getApplicationContext())
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)

        // One computer: shown all the same, saying it answers (c9adf9162); its most recent folder. No Happy Agent: Bot and Task dimmed.
        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(NewWorkTags.FOLDER)
        rule.onNode(hasText("● Online") and hasAnyAncestor(hasTestTag(NewWorkTags.MACHINE_STATUS)), useUnmergedTree = true).assertExists()
        rule.node(ComposeChatTags.kind(ComposeKind.Task)).assertIsNotEnabled()
        rule.node(ComposeChatTags.kind(ComposeKind.Bot)).assertIsNotEnabled()
        rule.waitUntil(5_000) { newSession.draft.value.selectedPath == "/h/repo" }
        rule.node(NewWorkTags.FOLDER).assertContentDescriptionEquals("~/repo")
        rule.node(NewWorkTags.FOLDER).performClick()
        rule.waitFor(ComposeChatTags.FOLDER_MENU)
        rule.node(ComposeChatTags.CUSTOM_PATH).assertExists()
        rule.onNodeWithText("New Bot…").assertDoesNotExist()
        rule.node(ComposeChatTags.option(NewSessionPage.Project, "/h/repo")).performClick()
        rule.node(HeaderTags.LEFT).performClick()
        rule.waitFor(HomeTags.COMPOSE)

        // A second computer, with a folder of its own: now the computer is asked, and the folder follows it.
        server.addMachine("m2", Journey.machineMetadata(), 2)
        server.addSession("s9", updatedAt = 200, metadata = Journey.sessionMetadata("/h/other", "Other chat", machineId = "m2"))
        server.dropSockets()
        rule.waitUntil(15_000) { HomeServices.of(graph).snapshots.value?.machines?.size == 2 }
        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(NewWorkTags.MACHINE)
        for ((machine, path) in listOf("m2" to "/h/other", "m1" to "/h/repo")) {
            rule.node(NewWorkTags.MACHINE).performClick()
            rule.waitFor(ComposeChatTags.MACHINE_MENU)
            rule.node(ComposeChatTags.option(NewSessionPage.Machine, machine)).performClick()
            rule.waitUntil(5_000) { newSession.draft.value.selectedMachineId == machine && newSession.draft.value.selectedPath == path }
        }
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletNewSessionComposesInTheDetailPaneAndBecomesTheChatInPlace() {
        journey.machine()
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        val spawns = journey.rpc(Journey.MACHINE, "spawn-happy-session") { request ->
            server.addSession(NEW, updatedAt = 90_000, metadata = Journey.sessionMetadata(request["directory"]!!.jsonPrimitive.content, "Fresh chat"))
            buildJsonObject { put("type", "success"); put("sessionId", NEW) }
        }
        val graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitFor(TabletSidebarTags.NEW_SESSION)

        // The sidebar's New session: the empty chat, beside the sidebar, not the new-session screen.
        rule.node(TabletSidebarTags.NEW_SESSION).performClick()
        rule.waitFor(ComposeChatTags.TARGET)
        rule.node(HomeDockTags.INPUT).assertDoesNotExist()
        val detail = rule.node(TabletShellTags.DETAIL).bounds
        val chat = rule.node(ChatScreenTags.SCREEN).bounds
        assertEquals(360f, detail.left.value, 0.5f)
        assertEquals(detail.left.value, chat.left.value, 0.5f)
        // Pressed again, the empty chat already there stays.
        rule.node(TabletSidebarTags.NEW_SESSION).performClick()
        rule.waitForIdle()
        rule.onAllNodes(hasTestTag(ChatScreenTags.SCREEN), useUnmergedTree = true).assertCountEquals(1)

        rule.node(ComposerTags.INPUT).performTextInput("Tidy the docs")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitFor(MessageTags.USER, 15_000)
        rule.waitUntilDoesNotExist(hasTestTag(ComposeChatTags.TARGET), 5_000)
        rule.onAllNodes(hasTestTag(ChatScreenTags.SCREEN), useUnmergedTree = true).assertCountEquals(1)
        assertEquals("/h/repo", spawns.single()["directory"]!!.jsonPrimitive.content)
        // Its row in the sidebar is the open one.
        rule.waitUntil(10_000) {
            rule.onAllNodes(hasTestTag(FlatRowTags.ROW) and isSelected() and hasAnyDescendant(hasText("Fresh chat")), useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
    }

    /**
     * happy-ios 500c1c485, 7f6007fe0: on a computer whose Happy Agent makes
     * tasks and bots the empty chat offers them. A bot without a name is
     * said inside its field and nothing starts; a task is made with
     * `target: {kind: "task"}` alone and the text as its first message.
     */
    @Test
    fun aHappyAgentComputerMakesTasksAndBotsFromTheEmptyChat() {
        server.addMachine(Journey.MACHINE, Journey.machineMetadata(), 1)
        server.addMachine(AGENT, happyAgentMetadata(sibling = Journey.MACHINE), 1)
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        val spawns = journey.rpc(AGENT, "spawn-happy-session") {
            server.addSession(NEW, updatedAt = 90_000, metadata = Journey.sessionMetadata("/h/Tasks/release", "Release", machineId = AGENT))
            buildJsonObject { put("type", "success"); put("sessionId", NEW) }
        }
        val graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)

        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(ComposeChatTags.TARGET)
        // A task asks only the computer, and its composer what it should do.
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(ComposeChatTags.kind(ComposeKind.Task)) and isEnabled(), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.node(ComposeChatTags.kind(ComposeKind.Task)).performClick()
        rule.waitForText("What should this task do?")
        rule.node(NewWorkTags.FOLDER).assertDoesNotExist()
        rule.node(ComposeChatTags.kind(ComposeKind.Bot)).performClick()
        rule.waitFor(NewWorkTags.NAME_FIELD)
        rule.node(NewWorkTags.FOLDER).assertDoesNotExist()
        rule.node(ComposerTags.INPUT).performTextInput("Own the releases")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitForText("Give the bot a name")
        assertTrue(spawns.isEmpty())

        rule.node(ComposeChatTags.kind(ComposeKind.Task)).performClick()
        rule.waitUntilDoesNotExist(hasTestTag(NewWorkTags.NAME_FIELD), 5_000)
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitFor(MessageTags.USER, 15_000)
        val spawn = spawns.single()
        assertEquals("happy-agent-spawn", spawn["type"]!!.jsonPrimitive.content)
        assertEquals(buildJsonObject { put("kind", "task") }, spawn["target"])
        rule.waitUntil(10_000) { server.sentRecords(NEW).any { "Own the releases" in it.second.toString() } }
    }

    private fun happyAgentMetadata(sibling: String) = buildJsonObject {
        put("host", "laptop")
        put("platform", "darwin")
        put("happyCliVersion", "1.2.3")
        put("happyHomeDir", "/h/.happy")
        put("homeDir", "/h")
        put("machineKind", "rig")
        put("siblingMachineId", sibling)
        putJsonObject("capabilities") { put("newSession", true); put("bots", true); put("tasks", true) }
        putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
        putJsonArray("models") {
            addJsonObject {
                put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                putJsonArray("thinkingLevels") { add("high") }
                put("defaultThinkingLevel", "high")
            }
        }
        putJsonArray("operatingModes") { addJsonObject { put("code", "auto"); put("value", "Auto") } }
    }

    private companion object {
        const val NEW = "s-new"
        const val AGENT = "agent1"
    }
}
