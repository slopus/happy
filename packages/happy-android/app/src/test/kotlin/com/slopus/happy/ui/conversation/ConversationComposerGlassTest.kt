package com.slopus.happy.ui.conversation

import android.provider.Settings
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.LocalGlassBlur
import com.slopus.happy.ui.components.glassBlurs
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.DarkColors
import com.slopus.happy.ui.theme.LightColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/** The composer's ChatGPT Work shape on glass: rest and open, the label, the fallback, contrast. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationComposerGlassTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)
    private val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")
    private val catalog = ModeCatalog(
        listOf(ModelChoice("claude", "Current CLI", "claude", "anthropic/opus-5", "Opus 5 1M", listOf("low", "medium", "high", "max"), "high", emptyList())),
        mode,
    )
    private val rows = (1..30).map { ConversationRow.Text("t$it", "Line $it of a long answer", parseMarkdown("Line $it of a long answer")) }

    private fun show(state: ConversationState, dark: Boolean = false, blur: Boolean? = null) {
        rule.setHappyContent(dark) {
            CompositionLocalProvider(LocalGlassBlur provides blur) { ConversationScreen(state, null, ConversationScreenActions()) }
        }
    }

    private fun pillHeight(): Dp = rule.node(ConversationComposerTags.PILL).bounds.height

    @Test fun `at rest one 48 pill, in use a two-row card with the label`() {
        show(ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog))
        assertEquals(48f, pillHeight().value, 0.5f)
        rule.node(ConversationModeTags.MODEL).assertDoesNotExist()

        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        val open = pillHeight()
        assertTrue("open card ~92, was $open", open.value in 88f..100f)
        val label = rule.node(ConversationModeTags.MODEL).bounds
        val primary = rule.node(ConversationComposerTags.PRIMARY).bounds
        assertTrue("label just before send: $label $primary", label.right in (primary.left - 16.dp)..(primary.left + 8.dp))

        // A long draft grows the card, up to its line cap.
        rule.node(ConversationComposerTags.INPUT).performTextInput((1..20).joinToString("\n") { "line $it" })
        rule.waitForIdle()
        val long = pillHeight()
        assertTrue("grows with the words, capped: $long", long > open && long.value < 320f)
    }

    @Test fun `the newest message stays above the composer`() {
        show(ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog))
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        // The list runs under the dock, so the glass has something to blur...
        assertTrue(rule.node(ConversationScreenTags.LIST).bounds.bottom >= pill.bottom)
        // ...and keeps the dock's height clear at its newest end.
        val line = rule.onNodeWithText("Line 1 of a long answer").bounds
        assertTrue("newest row ends above the pill", line.bottom <= pill.top)
    }

    @Test fun `TalkBack reads model and effort as one button`() {
        show(ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog))
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        rule.onAllNodes(hasContentDescription("Model Opus 5 1M, effort High")).assertCountEquals(1)
        rule.onAllNodes(hasContentDescription("Model Opus 5 1M, effort High"))[0]
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick))
    }

    @Test fun `with Reduce Motion the pill opens at once`() {
        Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        show(ConversationState(created = true, loaded = true, rows = rows, agent = agent, mode = mode, catalog = catalog))
        rule.mainClock.autoAdvance = false
        rule.node(ConversationComposerTags.INPUT).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        val first = pillHeight()
        rule.mainClock.advanceTimeBy(1_000)
        assertEquals(first, pillHeight())
        assertTrue(first.value > 80f)
    }

    @Test fun `only API 31 and up blur`() {
        assertFalse(glassBlurs(30))
        assertTrue(glassBlurs(31))
    }

    /** Where nothing blurs the pill is its tint alone, nearly opaque, over the page. */
    @Test fun `without blur the pill is the solid tint, light`() = solidTint(dark = false)

    @Test fun `without blur the pill is the solid tint, dark`() = solidTint(dark = true)

    private fun solidTint(dark: Boolean) {
        run {
            show(ConversationState(created = false, loaded = true, mode = mode, catalog = catalog), dark = dark, blur = false)
            val image = rule.onRoot().captureToImage().asAndroidBitmap()
            val pill = rule.node(ConversationComposerTags.PILL).bounds
            val scale = image.width / 411f
            // Between [+] and the placeholder's top, on the pill's fill.
            val x = ((pill.left.value + 60) * scale).toInt()
            val y = ((pill.top.value + 4) * scale).toInt()
            val page = if (dark) DarkColors.surface else LightColors.surface
            val expected = GlassColors.of(dark).fill(blurs = false).compositeOver(page)
            val actual = Color(image.getPixel(x, y))
            assertTrue("dark=$dark expected $expected was $actual", close(expected, actual))
        }
    }

    /** Placeholder and label over the tint at its most see-through, over black and white alike. */
    @Test fun `placeholder and label keep their contrast over the glass`() {
        for ((dark, colors) in listOf(false to LightColors, true to DarkColors)) {
            for (behind in listOf(Color.Black, Color.White, colors.surface)) {
                val fill = GlassColors.of(dark).fill(blurs = true).compositeOver(behind)
                assertTrue("placeholder dark=$dark over $behind", contrast(colors.textSecondary, fill) >= 4.5f)
                assertTrue("label dark=$dark over $behind", contrast(colors.text, fill) >= 4.5f)
            }
        }
    }

    private fun close(a: Color, b: Color) = abs(a.red - b.red) < 0.03f && abs(a.green - b.green) < 0.03f && abs(a.blue - b.blue) < 0.03f

    private fun contrast(a: Color, b: Color): Float {
        val (hi, lo) = listOf(a.luminance(), b.luminance()).sortedDescending()
        return (hi + 0.05f) / (lo + 0.05f)
    }
}
