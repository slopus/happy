package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The model and effort chips and their lists (iOS e2238fdc4, 083c30df4). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ModelPickerTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val catalog = ModeCatalog.parse(
        Json.parseToJsonElement(
            """{"config":{
            "defaults":{"providerId":"claude","modelId":"opus","permissionMode":"auto"},
            "models":{
                "opus":{"name":"Opus 5 1M","efforts":["low","medium","high","max"],"defaultEffort":"high"},
                "sonnet":{"name":"Sonnet 5","efforts":["low","high"],"defaultEffort":"high"},
                "haiku":{"name":"Haiku 5","efforts":["low"],"defaultEffort":"low"},
                "sol":{"name":"GPT-6 Sol","efforts":["low","medium","high","xhigh"],"defaultEffort":"medium"}
            },
            "providers":{
                "claude":{"name":"Current CLI","type":"claude","enabled":true,"hidden":false,"models":[{"id":"opus","enabled":true},{"id":"sonnet","enabled":true},{"id":"haiku","enabled":true,"hidden":true}]},
                "work":{"name":"Work","type":"claude","enabled":true,"hidden":false,"models":[{"id":"sonnet","enabled":true}]},
                "codex":{"type":"codex","enabled":true,"hidden":false,"models":[{"id":"sol","enabled":true}]}
            }}}""",
        ).jsonObject,
    )
    private val mode = Mode("claude", "opus", "high", null, "auto")
    private val rows = (1..30).map { ConversationRow.Text("t$it", "Line $it of a long answer", parseMarkdown("Line $it of a long answer")) }
    private val usage = mapOf(
        "claude" to AccountUsage(
            week = AccountUsage.Window(AccountUsage.Window.Kind.Week, 82.0, resetsAt = System.currentTimeMillis() + 3 * 86_400_000L),
            session = AccountUsage.Window(AccountUsage.Window.Kind.Session, 40.0),
            updatedAt = System.currentTimeMillis() - 5 * 60_000L,
        ),
        "work" to AccountUsage(week = AccountUsage.Window(AccountUsage.Window.Kind.Week, 10.0)),
    )

    private fun show(dark: Boolean = false, picks: MutableList<Mode> = ArrayList(), asked: MutableList<List<String>> = ArrayList(), current: Mode = mode) {
        rule.setHappyContent(dark) {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = current, catalog = catalog),
                ConversationScreenActions(onModeChange = { picks += it }),
                usage = usage,
                onRefreshUsage = { asked += it },
            )
        }
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
    }

    private fun screenBounds(tag: String) = rule.node(tag).fetchSemanticsNode().let { Rect(it.positionOnScreen, it.size.toSize()) }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        val popup = rule.onAllNodes(isPopup()).fetchSemanticsNodes().isNotEmpty()
        val bitmap = (if (popup) rule.onNode(isPopup()) else rule.onRoot()).captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val screen = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name-screen.png").outputStream().use { screen.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun `the model list stands over its chip, services under headings, the hidden model out, and asks for fresh readings`() {
        val asked = ArrayList<List<String>>()
        show(asked = asked)
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        val panel = screenBounds(ModelPickerTags.PANEL)
        val chip = screenBounds(ConversationModeTags.MODEL)
        assertEquals(chip.top - 10 * rule.density.density, panel.bottom, 1f)
        assertEquals(chip.right, panel.right, 1f)
        rule.node(ModelPickerTags.heading("claude")).assertExists()
        rule.node(ModelPickerTags.heading("codex")).assertExists()
        rule.node(ModelPickerTags.option(PickerKeys.model("claude", "opus"))).assertExists()
        rule.node(ModelPickerTags.option(PickerKeys.model("claude", "haiku"))).assertDoesNotExist()
        rule.onNodeWithText("Haiku 5").assertDoesNotExist()
        assertEquals(listOf(listOf("claude", "work", "codex")), asked)
        shot("model-picker-models")
    }

    @Test fun `a heading opens its accounts over the list, and an account switched keeps the models up on its model`() {
        val picks = ArrayList<Mode>()
        show(picks = picks)
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        rule.node(ModelPickerTags.heading("claude")).performClick()
        rule.waitForIdle()
        rule.node(ModelPickerTags.ACCOUNTS).assertExists()
        rule.node(ModelPickerTags.WINDOWS).assertExists()
        // Stacked in place: the same trailing edge and bottom as the list under it.
        val accounts = screenBounds(ModelPickerTags.ACCOUNTS)
        val panel = screenBounds(ModelPickerTags.PANEL)
        assertEquals(panel.bottom, accounts.bottom, 1f)
        assertEquals(panel.right, accounts.right, 1f)
        shot("model-picker-accounts")
        rule.node(ModelPickerTags.option(PickerKeys.account("work"))).performClick()
        rule.waitForIdle()
        // Work doesn't offer Opus: its first model, at the effort it can run.
        assertEquals(listOf(Mode("work", "sonnet", "high", null, "auto")), picks)
        rule.node(ModelPickerTags.ACCOUNTS).assertDoesNotExist()
        rule.node(ModelPickerTags.PANEL).assertExists()
    }

    @Test fun `the effort list over its chip picks the effort and closes`() {
        val picks = ArrayList<Mode>()
        show(dark = true, picks = picks)
        rule.node(ConversationModeTags.EFFORT).performClick()
        rule.waitForIdle()
        shot("model-picker-efforts-dark")
        rule.node(ModelPickerTags.option(PickerKeys.effort("max"))).performClick()
        rule.waitForIdle()
        assertEquals(listOf(mode.copy(effort = "max")), picks)
        rule.node(ModelPickerTags.PANEL).assertDoesNotExist()
    }

    @Test fun `the model chip wears the ring of the selected account and the heading its warning`() {
        show(current = mode)
        rule.node(ContextMeterTags.RING).assertExists()
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        shot("model-picker-warning")
    }

    @Test @Config(qualifiers = "w411dp-h480dp-xxhdpi")
    fun `a long list opens on the checked line`() {
        val many = ModeCatalog.parse(
            Json.parseToJsonElement(
                """{"config":{"defaults":{"providerId":"p","modelId":"m18","permissionMode":"auto"},"models":{${(1..24).joinToString(",") { "\"m$it\":{\"name\":\"Model $it\",\"efforts\":[\"low\"],\"defaultEffort\":\"low\"}" }}},""" +
                    """"providers":{"p":{"type":"claude","enabled":true,"models":[${(1..24).joinToString(",") { "{\"id\":\"m$it\",\"enabled\":true}" }}]}}}}""",
            ).jsonObject,
        )
        val current = Mode("p", "m18", "low", null, "auto")
        rule.setHappyContent {
            ConversationScreen(ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = current, catalog = many), ConversationScreenActions())
        }
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        rule.node(ConversationModeTags.MODEL).performClick()
        rule.waitForIdle()
        val panel = screenBounds(ModelPickerTags.PANEL)
        val checked = screenBounds(ModelPickerTags.option(PickerKeys.model("p", "m18")))
        assertTrue("checked line in the panel: $checked in $panel", checked.top >= panel.top && checked.bottom <= panel.bottom)
        // Scrolled to it: the top of the list is out of view.
        rule.onNodeWithText("Model 1").assertIsNotDisplayed()
    }
}
