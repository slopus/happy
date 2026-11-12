package com.slopus.happy.journeys

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.connect.DeepLinks
import com.slopus.happy.ui.connect.parseDeepLink
import com.slopus.happy.ui.home.BotKindTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeDockTags
import com.slopus.happy.ui.node
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Bots: on a Happy Agent that publishes `capabilities.bots` the
 * new-session screen (`/new`; compose's empty chat makes sessions only, as
 * iOS's does) offers Session | Bot; a named bot is created on it, and its
 * chat opens. No face is painted, uploaded or worn: the bot wears the
 * placeholder its ID picks.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BotJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server

    @After
    fun tearDown() = journey.close()

    @Test
    fun createABot() {
        server.addMachine(
            AGENT,
            buildJsonObject {
                put("host", "agentbox")
                put("platform", "linux")
                put("happyCliVersion", "1.2.3")
                put("happyHomeDir", "/h/.happy")
                put("homeDir", "/h")
                put("machineKind", "rig")
                putJsonObject("capabilities") { put("newSession", true); put("bots", true) }
                putJsonObject("defaults") { put("providerId", "codex"); put("modelId", "gpt"); put("permissionMode", "auto") }
                putJsonArray("models") {
                    addJsonObject {
                        put("code", "gpt"); put("value", "GPT"); put("providerId", "codex"); put("id", "gpt")
                        putJsonArray("thinkingLevels") { add("low"); add("high") }
                        put("defaultThinkingLevel", "high")
                    }
                }
                putJsonArray("operatingModes") { addJsonObject { put("code", "auto"); put("value", "Auto") } }
            },
        )
        journey.session("s0", updatedAt = 100, title = "Existing chat")
        val spawns = journey.rpc(AGENT, "spawn-happy-session") {
            server.addSession(BOT, updatedAt = 90_000, metadata = Journey.sessionMetadata("/h", "Release Bot", machineId = AGENT))
            buildJsonObject { put("type", "success"); put("sessionId", BOT) }
        }
        val avatars = journey.rpc(BOT, "setAvatar") { buildJsonObject { put("success", true) } }

        val graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)

        // `/new`, then Bot: named.
        DeepLinks.offer(parseDeepLink("happy://new")!!)
        rule.waitFor(BotKindTags.KIND)
        rule.node(BotKindTags.kind(true)).performClick()
        rule.waitFor(BotKindTags.LEDE)
        rule.node(BotKindTags.kind(true)).assertIsSelected()
        rule.node(HomeDockTags.INPUT).performTextInput("Release Bot")
        rule.assertActionsLabelled()
        rule.onNode(hasContentDescription("Create bot") and hasClickAction(), useUnmergedTree = true).performClick()

        rule.waitFor(ChatScreenTags.SCREEN)

        assertEquals(1, spawns.size)
        val spawn = spawns.single()
        assertEquals("happy-agent-spawn", spawn["type"]!!.jsonPrimitive.content)
        assertTrue(spawn.toString(), "Release Bot" in spawn["target"]!!.jsonObject.toString())
        assertTrue(avatars.isEmpty())
        assertTrue(server.attachments.isEmpty())
        // No first message: a bot is made, not asked.
        assertTrue(server.sentRecords(BOT).isEmpty())
    }

    private companion object {
        const val AGENT = "agent1"
        const val BOT = "bot1"
    }
}
