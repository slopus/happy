package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyDescendant
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
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposeChatTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.NewWorkTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.tablet.TabletShellTags
import com.slopus.happy.ui.tablet.TabletSidebarTags
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import com.slopus.happy.ui.chat.ComposerPickerTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.PickerSheetTags
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
    fun theComputerIsAskedOnlyWithTwoAndTheFoldersFollowIt() {
        journey.machine()
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        val graph = journey.graph()
        journey.signIn(graph)
        val newSession = HomeServices.of(graph).newSession(ApplicationProvider.getApplicationContext())
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)

        // One computer: only its folder, its most recent one, centred over the empty chat. No bot here.
        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(NewWorkTags.FOLDER)
        rule.node(NewWorkTags.MACHINE).assertDoesNotExist()
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

    /**
     * The matrix's bug D: the empty chat's model chip listed Claude Code's
     * defaults and wrote a pick nowhere the start reads, so a Happy Agent
     * session started on the computer's default model. The chip is the
     * draft's, from the computer's own catalog, and a pick is what spawns.
     */
    @Test
    fun theModelPickedInTheEmptyChatIsTheOneTheSessionStartsOn() {
        server.addMachine(
            AGENT,
            buildJsonObject {
                put("host", "agentbox")
                put("platform", "darwin")
                put("happyCliVersion", "0.4.111")
                put("happyHomeDir", "/h/.happy")
                put("homeDir", "/h")
                put("machineKind", "rig")
                putJsonObject("capabilities") { put("newSession", true) }
                putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
                putJsonArray("models") {
                    addJsonObject {
                        put("code", "gpt"); put("value", "GPT-6.1 Sol"); put("providerId", "codex"); put("providerName", "Codex"); put("id", "gpt")
                        putJsonArray("thinkingLevels") { add("low"); add("high") }
                        put("defaultThinkingLevel", "high")
                    }
                    addJsonObject {
                        put("code", "opus"); put("value", "Opus 5 1M"); put("providerId", "claude"); put("providerName", "Claude Code"); put("id", "opus")
                        putJsonArray("thinkingLevels") { add("medium"); add("max") }
                        put("defaultThinkingLevel", "medium")
                    }
                }
                putJsonArray("operatingModes") { addJsonObject { put("code", "auto"); put("value", "Auto") } }
            },
        )
        server.addSession("s0", updatedAt = 100, metadata = Journey.sessionMetadata("/h", "Existing chat", machineId = AGENT))
        val spawns = journey.rpc(AGENT, "spawn-happy-session") {
            server.addSession(NEW, updatedAt = 90_000, metadata = Journey.sessionMetadata("/h", "Fresh chat", machineId = AGENT))
            buildJsonObject { put("type", "success"); put("sessionId", NEW) }
        }
        val graph = journey.graph()
        journey.signIn(graph)
        val newSession = HomeServices.of(graph).newSession(ApplicationProvider.getApplicationContext())
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)

        rule.node(HomeTags.COMPOSE).performClick()
        rule.waitFor(ComposeChatTags.TARGET)
        // The computer's default, from its catalog.
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(ComposerPickerTags.MODEL) and hasAnyDescendant(hasText("GPT-6.1 Sol")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.node(ComposerPickerTags.MODEL).performClick()
        rule.waitFor(PickerSheetTags.option("claude:opus"))
        rule.onNodeWithText("Fable 5.1").assertDoesNotExist()
        rule.node(PickerSheetTags.option("claude:opus")).performClick()
        rule.waitUntil(5_000) { newSession.draft.value.modelMode == "claude:opus" }
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(ComposerPickerTags.EFFORT) and hasAnyDescendant(hasText("Medium")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

        rule.node(ComposerTags.INPUT).performTextInput("Which model are you?")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntil(15_000) { spawns.isNotEmpty() }
        val spawn = spawns.single().toString()
        assertTrue(spawn, "\"providerId\":\"claude\"" in spawn && "\"modelId\":\"opus\"" in spawn && "\"effort\":\"medium\"" in spawn)
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

    private companion object {
        const val NEW = "s-new"
        const val AGENT = "agent1"
    }
}
