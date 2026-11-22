package com.slopus.happy.fixture

import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onChild
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.conversation.ConversationModeTags
import com.slopus.happy.ui.conversation.ConversationRowTags
import com.slopus.happy.ui.conversation.ModelPickerTags
import com.slopus.happy.ui.conversation.PickerKeys
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The speed choice on a device: the real conversation over a fixture agent
 * ([FixtureTransport]) whose computer offers a GPT model with the speed
 * menu Regular, Fast, Ultrafast and a Claude model with none. Every model and chat here is synthetic. Shots go
 * to the test app's files under `device-evidence/model-speed/`.
 */
@RunWith(AndroidJUnit4::class)
class ModelSpeedDeviceShots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence/model-speed").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val transport = FixtureTransport().apply {
        config = CONFIG
        mode = """{"providerId":"codex","modelId":"openai/gpt-6.2-sol","effort":"high","serviceTier":null,"permissionMode":"auto"}"""
    }

    @After fun stop() = scope.cancel()

    private fun node(tag: String) = rule.onNodeWithTag(tag, useUnmergedTree = true)

    private fun shown(tag: String) = rule.waitUntil(5_000) { rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun gone(tag: String) = rule.waitUntil(5_000) { rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }

    private fun capture(name: String) {
        rule.waitForIdle()
        SystemClock.sleep(700)
        device.takeScreenshot(File(evidence, "$name.png"))
        android.util.Log.i("ModelSpeed", "$name captured")
    }

    /** The mode the newest send (`mode`) or draft save (`draft`, the mode with its text) carried. */
    private fun lastMode(): JsonObject? = transport.bodies.toList().asReversed().firstNotNullOfOrNull { (_, body) ->
        val o = body as? JsonObject ?: return@firstNotNullOfOrNull null
        (o["mode"] ?: o["draft"]) as? JsonObject
    }

    @Test fun speedOnlyWhereTheModelOffersFast() {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        rule.setContent { HappyTheme { FixtureScreens(transport, scope) { it.start() } } }
        shown(ConversationRowTags.MEDIA)
        node(ConversationComposerTags.INPUT).performClick()
        shown(ConversationModeTags.EFFORT)

        capture("0-gpt-chip-regular")

        // GPT has a speed menu: the effort list ends with it, Regular checked.
        node(ConversationModeTags.EFFORT).performClick()
        shown(ModelPickerTags.PANEL)
        node(ModelPickerTags.option(PickerKeys.speed(null))).onChild().assertIsSelected()
        capture("1-gpt-effort-list-regular")
        node(ModelPickerTags.option(PickerKeys.speed("ultrafast"))).performClick()
        gone(ModelPickerTags.PANEL)
        capture("2-gpt-chip-ultrafast")
        rule.waitUntil(5_000) { lastMode()?.get("serviceTier")?.toString() == "\"ultrafast\"" }

        node(ConversationModeTags.EFFORT).performClick()
        shown(ModelPickerTags.PANEL)
        node(ModelPickerTags.option(PickerKeys.speed("ultrafast"))).onChild().assertIsSelected()
        capture("3-gpt-effort-list-ultrafast")
        device.pressBack()
        gone(ModelPickerTags.PANEL)

        // Opus has no speed menu: the pick drops Ultrafast, and its effort list has no speed.
        node(ConversationModeTags.MODEL).performClick()
        shown(ModelPickerTags.PANEL)
        capture("4-model-list")
        node(ModelPickerTags.option(PickerKeys.model("claude", "anthropic/opus-5.5"))).performClick()
        gone(ModelPickerTags.PANEL)
        rule.waitUntil(5_000) { lastMode()?.get("modelId")?.toString() == "\"anthropic/opus-5.5\"" }
        assertEquals("null", lastMode()?.get("serviceTier")?.toString())
        node(ConversationModeTags.EFFORT).performClick()
        shown(ModelPickerTags.PANEL)
        assertTrue(rule.onAllNodesWithTag(ModelPickerTags.option(PickerKeys.speed(null)), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        capture("5-opus-effort-list-no-speed")
        device.pressBack()
        gone(ModelPickerTags.PANEL)
        capture("7-opus-chip-no-speed")

        // Back on GPT at Fast, a message goes out with "priority".
        node(ConversationModeTags.MODEL).performClick()
        shown(ModelPickerTags.PANEL)
        node(ModelPickerTags.option(PickerKeys.model("codex", "openai/gpt-6.2-sol"))).performClick()
        gone(ModelPickerTags.PANEL)
        node(ConversationModeTags.EFFORT).performClick()
        shown(ModelPickerTags.PANEL)
        node(ModelPickerTags.option(PickerKeys.speed("priority"))).performClick()
        gone(ModelPickerTags.PANEL)
        capture("6-gpt-chip-fast")
        node(ConversationComposerTags.INPUT).performTextInput("Synthetic speed check")
        node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitUntil(5_000) { transport.bodies.any { it.first.endsWith("/send") } }
        val sent = transport.bodies.last { it.first.endsWith("/send") }.second as JsonObject
        android.util.Log.i("ModelSpeed", "send mode: ${sent["mode"]}")
        assertEquals("\"priority\"", sent["mode"]?.jsonObject?.get("serviceTier")?.toString())
        assertEquals("\"openai/gpt-6.2-sol\"", sent["mode"]?.jsonObject?.get("modelId")?.toString())
    }

    private companion object {
        const val CONFIG = """{"config":{
            "defaults":{"providerId":"codex","modelId":"openai/gpt-6.2-sol","permissionMode":"auto"},
            "models":{
                "openai/gpt-6.2-sol":{"name":"GPT-6.2 Sol","efforts":["low","medium","high","xhigh"],"defaultEffort":"medium","serviceTiers":["priority","ultrafast"],
                    "serviceTierOptions":[{"id":null,"label":"Regular"},{"id":"priority","label":"Fast"},{"id":"ultrafast","label":"Ultrafast"}]},
                "anthropic/opus-5.5":{"name":"Opus 5.5","efforts":["low","medium","high","max"],"defaultEffort":"high","serviceTiers":[]}
            },
            "providers":{
                "codex":{"name":"Fixture Codex","type":"codex","models":[{"id":"openai/gpt-6.2-sol","serviceTiers":["priority","ultrafast"],
                    "serviceTierOptions":[{"id":null,"label":"Regular"},{"id":"priority","label":"Fast"},{"id":"ultrafast","label":"Ultrafast"}]}]},
                "claude":{"name":"Fixture Claude","type":"claude","models":[{"id":"anthropic/opus-5.5"}]}
            }
        }}"""
    }
}
