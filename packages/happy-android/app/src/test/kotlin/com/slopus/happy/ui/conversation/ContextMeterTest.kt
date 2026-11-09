package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ContextMeasurement
import com.slopus.happy.conversation.ContextWindow
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The context meter under the composer and the usage ring on the model label (iOS 083c30df4). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ContextMeterTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")
    private val catalog = ModeCatalog(
        listOf(ModelChoice("claude", "Current CLI", "claude", "anthropic/opus-5", "Opus 5", listOf("low", "medium", "high", "max"), "high", emptyList())),
        mode,
        mapOf("anthropic/opus-5" to ContextWindow(200_000, 160_000)),
    )
    private val rows = (1..30).map { ConversationRow.Text("t$it", "Line $it of a long answer", parseMarkdown("Line $it of a long answer")) }
    private fun measured(tokens: Double) = ContextMeasurement(false, tokens, 200_000.0, "anthropic/opus-5", "claude")
    private fun state(context: ContextMeasurement?) =
        ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog, context = context)

    private var shown by mutableStateOf(ConversationState())
    private var usage by mutableStateOf<Map<String, AccountUsage>>(emptyMap())

    private fun show(state: ConversationState, dark: Boolean = false) {
        shown = state
        rule.setHappyContent(dark) { ConversationScreen(shown, ConversationScreenActions(), usage = usage) }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun description(tag: String) = rule.node(tag).fetchSemanticsNode().config[SemanticsProperties.ContentDescription].joinToString()

    @Test fun `the meter stands in its own row under the pill, its bar's end under send, and a tap reveals the numbers`() {
        show(state(measured(84_000.0)))
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        val meter = rule.node(ContextMeterTags.METER).bounds
        val send = rule.node(ConversationComposerTags.PRIMARY).bounds
        assertEquals(pill.bottom.value, meter.top.value, 0.5f)
        assertEquals(ContextMeterSpec.height.value, meter.height.value, 0.5f)
        assertEquals(send.right.value, meter.right.value, 0.5f)
        // The composer's foot is the meter's row, 20 under the pill, not 8.
        assertEquals(meter.bottom.value, rule.node(ConversationComposerTags.COMPOSER).bounds.bottom.value, 0.5f)
        assertTrue(description(ContextMeterTags.METER).startsWith("84k of 200k context tokens used · compacts at 160k"))
        assertEquals(0f, rule.node(ContextMeterTags.READOUT).bounds.width.value, 0.5f)
        shot("context-meter-rest")
        rule.node(ContextMeterTags.METER).performClick()
        rule.waitForIdle()
        assertTrue(rule.node(ContextMeterTags.READOUT).bounds.width.value > 40f)
        shot("context-meter-revealed")
        // It hides by itself after four seconds.
        rule.mainClock.advanceTimeBy(ContextMeterSpec.REVEAL_MS + 500)
        rule.waitForIdle()
        assertEquals(0f, rule.node(ContextMeterTags.READOUT).bounds.width.value, 0.5f)
    }

    @Test fun `near compaction it takes the warning colour and says so, at it the error colour`() {
        show(state(measured(140_000.0)), dark = true)
        assertTrue(description(ContextMeterTags.METER).endsWith("compaction is close; compact now to choose the moment"))
        rule.node(ContextMeterTags.METER).performClick()
        rule.waitForIdle()
        shot("context-meter-compact-dark")
    }

    @Test fun `before a measurement the window shows with a dash, and there is no meter without a window or before the chat exists`() {
        show(state(null))
        assertTrue(description(ContextMeterTags.METER).startsWith("Waiting for the first context measurement (200k token window)"))
        shown = state(null).copy(catalog = catalog.copy(windows = emptyMap()))
        rule.waitForIdle()
        rule.node(ContextMeterTags.METER).assertDoesNotExist()
        assertEquals(8f, rule.node(ConversationComposerTags.COMPOSER).bounds.bottom.value - rule.node(ConversationComposerTags.PILL).bounds.bottom.value, 0.5f)
    }

    @Test fun `the model label wears a ring while its account runs low and reads the warning out`() {
        val low = AccountUsage(week = AccountUsage.Window(AccountUsage.Window.Kind.Week, 88.0), session = AccountUsage.Window(AccountUsage.Window.Kind.Session, 10.0))
        usage = mapOf("claude" to low)
        show(state(measured(84_000.0)))
        rule.node(ConversationComposerTags.INPUT).performTextInput("Hi")
        rule.waitForIdle()
        val ring = rule.node(ContextMeterTags.RING).bounds
        assertEquals(UsageRingSpec.size.value, ring.width.value, 0.5f)
        assertTrue(description(ConversationModeTags.MODEL).endsWith("Weekly limit · 12% left."))
        shot("context-meter-usage-ring")
        // An account with room has no ring.
        usage = mapOf("claude" to AccountUsage(week = AccountUsage.Window(AccountUsage.Window.Kind.Week, 30.0)))
        rule.waitForIdle()
        rule.node(ContextMeterTags.RING).assertDoesNotExist()
    }
}
