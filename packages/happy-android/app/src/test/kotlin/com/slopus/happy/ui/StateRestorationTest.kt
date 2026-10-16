package com.slopus.happy.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.model.NewSessionPage
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.chat.ChatListTags
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerPickerTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.components.PickerSheetTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeDockTags
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * What a recreated activity keeps. [StateRestorationTester] disposes the
 * composition and builds it again from the saved instance state:
 * - with the same [AppGraph], that is a configuration change the manifest
 *   doesn't handle (a locale change) or a recreation from the system;
 * - with a new graph over the same database and preferences, it is the
 *   process dying in the background and coming back.
 * Rotation, dark/light and font scale don't recreate (`configChanges`).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StateRestorationTest {
    @get:Rule
    val rule = createComposeRule()

    private val server = FakeHappyServer().start()
    private val graphs = mutableListOf<AppGraph>()

    /** The Android keystore outlives the process; so does this. */
    private val keys = SoftwareKeys()

    @After
    fun tearDown() {
        graphs.forEach { runBlocking { it.account.value?.stop() } }
        server.close()
    }

    private fun graph(): AppGraph = AppGraph(
        context = ApplicationProvider.getApplicationContext(),
        clientId = "android/test",
        defaultServerUrl = server.url,
        secureStoreKeys = keys,
        databaseName = "restoration.db",
    ).also { graphs += it }

    private fun waitFor(tag: String) = rule.waitUntilAtLeastOneExists(hasTestTag(tag), 10_000)

    private fun chatWithHistory() {
        server.addMachine("m1")
        server.addSession(
            "s1",
            updatedAt = 100,
            metadata = buildJsonObject {
                put("path", "/repo")
                put("host", "devbox")
                put("machineId", "m1")
                put("flavor", "claude")
                put("summary", buildJsonObject { put("text", "Chat"); put("updatedAt", 1) })
            },
        )
        repeat(60) { n ->
            server.appendMessage("s1", buildJsonObject {
                put("role", "user")
                put("content", buildJsonObject { put("type", "text"); put("text", "message $n") })
            })
        }
    }

    /** Signs in, opens the chat, types a draft and scrolls back 30 rows. */
    private fun openChat(restoration: StateRestorationTester, current: () -> AppGraph) {
        runBlocking { current().auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        restoration.setContent { HappyApp(current()) }
        waitFor(FlatRowTags.ROW)
        rule.node(FlatRowTags.ROW).performClick()
        waitFor(MessageTags.USER)
        rule.node(ComposerTags.INPUT).performTextInput("half a thought")
        rule.node(ChatListTags.LIST).performScrollToIndex(30)
        rule.waitForIdle()
    }

    @Test
    fun aRecreatedActivityKeepsTheChatTheDraftTheScrollAndAnOpenPicker() {
        chatWithHistory()
        val restoration = StateRestorationTester(rule)
        val graph = graph()
        openChat(restoration) { graph }
        rule.node(ComposerPickerTags.PERMISSION).performClick()
        waitFor(PickerSheetTags.PANEL)
        val before = topMessage()

        restoration.emulateSavedInstanceStateRestore()

        waitFor(ChatScreenTags.SCREEN)
        waitFor(PickerSheetTags.PANEL)
        waitFor(ComposerTags.INPUT)
        rule.node(ComposerTags.INPUT).assertTextEquals("half a thought")
        assertTrue("scrolled back", before != null && before != "message 59")
        rule.waitUntil(5_000) { topMessage() == before }
    }

    @Test
    fun processDeathKeepsTheChatAndTheDraft() {
        chatWithHistory()
        val restoration = StateRestorationTester(rule)
        var current by mutableStateOf(graph())
        openChat(restoration) { current }
        // The draft is written to the database as it is typed.
        rule.waitUntil(5_000) { current.account.value?.composer?.mirrors?.value?.get("s1")?.draft == "half a thought" }
        val before = topMessage()
        runBlocking { current.account.value?.stop() }

        current = graph()
        restoration.emulateSavedInstanceStateRestore()

        waitFor(ChatScreenTags.SCREEN)
        rule.waitUntil(10_000) {
            rule.onAllNodesWithTag(ComposerTags.INPUT, useUnmergedTree = true).fetchSemanticsNodes().singleOrNull()
                ?.config?.let { c -> c.getOrNull(SemanticsProperties.EditableText)?.text == "half a thought" } == true
        }
        rule.waitUntil(10_000) { topMessage() == before }
        assertTrue("scrolled back", before != null && before != "message 59")
    }

    @Test
    fun theHomeDockKeepsItsTextItsPickerAndStaysOpenThroughARecreationAndProcessDeath() {
        chatWithHistory()
        val restoration = StateRestorationTester(rule)
        var current by mutableStateOf(graph())
        runBlocking { current.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        restoration.setContent { HappyApp(current) }
        waitFor(HomeDockTags.CAPSULE)
        rule.node(HomeDockTags.CAPSULE).performClick()
        waitFor(HomeDockTags.INPUT)
        rule.node(HomeDockTags.INPUT).performTextInput("a new idea")
        rule.node(HomeDockTags.row(NewSessionPage.Machine)).performClick()
        waitFor(PickerSheetTags.PANEL)

        restoration.emulateSavedInstanceStateRestore()
        waitFor(HomeDockTags.FOCUS)
        rule.node(HomeDockTags.INPUT).assertTextEquals("a new idea")
        // The machine picker is still open in place of the rows.
        waitFor(PickerSheetTags.PANEL)

        runBlocking { current.account.value?.stop() }
        current = graph()
        restoration.emulateSavedInstanceStateRestore()
        waitFor(HomeDockTags.FOCUS)
        rule.node(HomeDockTags.INPUT).assertTextEquals("a new idea")
    }

    /** The oldest message wholly on screen: what the reader was looking at. */
    private fun topMessage(): String? {
        val list = rule.onAllNodesWithTag(ChatListTags.LIST, useUnmergedTree = true).fetchSemanticsNodes().singleOrNull() ?: return null
        return rule.onAllNodes(hasText("message ", substring = true), useUnmergedTree = true).fetchSemanticsNodes()
            .filter { it.boundsInRoot.top >= list.boundsInRoot.top && it.boundsInRoot.bottom <= list.boundsInRoot.bottom }
            .minByOrNull { it.boundsInRoot.top }
            ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString()
    }
}
