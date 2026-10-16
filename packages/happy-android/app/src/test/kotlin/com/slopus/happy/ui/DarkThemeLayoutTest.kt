package com.slopus.happy.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.diff.DiffBuilder
import com.slopus.happy.ui.attachments.AttachmentStrip
import com.slopus.happy.ui.attachments.AttachmentStripTags
import com.slopus.happy.ui.chat.ChatTheme
import com.slopus.happy.ui.chat.CliWarningPill
import com.slopus.happy.ui.chat.CopyMenuContent
import com.slopus.happy.ui.chat.CopyMenuTags
import com.slopus.happy.ui.chat.DarkChatColors
import com.slopus.happy.ui.chat.LightChatColors
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.chat.SessionNoticeTags
import com.slopus.happy.ui.diff.DiffFileView
import com.slopus.happy.ui.diff.DiffTags
import com.slopus.happy.ui.diff.LocalDiffSyntax
import com.slopus.happy.ui.home.BotFacePicker
import com.slopus.happy.ui.home.BotFaceTags
import com.slopus.happy.ui.home.BotKindHeader
import com.slopus.happy.ui.home.HomeDockBot
import com.slopus.happy.ui.theme.rgba
import com.slopus.happy.ui.usage.ContextGauge
import com.slopus.happy.ui.usage.UsageRowTags
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The screens with colours of their own, in happy-app's dark theme
 * (theme.ts `darkTheme`, Android branch):
 * - Diffs (DiffPalette.ts over `diff.*`): added rows #12261E with a #1B4721
 *   gutter, removed rows #25171C with #78191B, `@@` rows on #161B22; none of
 *   the light palette's #E6FFEC.
 * - Code blocks (MarkdownView): the card on surfaceHighest #282828, the
 *   copy button on it with a divider #2A2A2A border; keywords in
 *   syntaxKeyword #569CD6 (SimpleSyntaxHighlighter).
 * - ContextGaugeIcon: the track in divider #2A2A2A, the used share white
 *   (rgba(255, 255, 255, 0.35 + 0.65 x used)), never black.
 * - LongPressCopyable's menu: surface #161616 under a divider border.
 * - The CLI warning pill (SessionView): #FFF3CD in both themes.
 * - AgentInputAttachmentStrip: the remove button on surfaceHigh #1E1E1E.
 * - The composer and dock glass border: `glass.border`, white at 0.14 in
 *   dark and 0.82 in light.
 * - BotFacePicker / NativeSegmentedControl: the picked face ringed in text
 *   (white), the Session | Bot track in glass.backgroundSubtle and the
 *   chosen segment on surfaceHighest #282828.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DarkThemeLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun hex(value: Long) = Color(0xFF000000 or value)

    /** The colours [node] paints, as ARGB ints. */
    private fun SemanticsNodeInteraction.paints(): Set<Int> {
        val map = captureToImage().toPixelMap()
        return buildSet { for (y in 0 until map.height) for (x in 0 until map.width) add(map[x, y].toArgb()) }
    }

    /** Whether [color] is among [painted], within a step of rounding per channel. */
    private fun painted(painted: Set<Int>, color: Color): Boolean {
        val want = color.toArgb()
        return painted.any { got ->
            (0..24 step 8).all { shift -> kotlin.math.abs(((got shr shift) and 0xFF) - ((want shr shift) and 0xFF)) <= 1 }
        }
    }

    @Test
    fun diffsUseTheDarkPalette() {
        val file = DiffBuilder.fromContents("a.txt", "one\ntwo\n", "one\nthree\n").files.single()
        rule.setHappyContent(dark = true) {
            CompositionLocalProvider(LocalDiffSyntax provides null) {
                Column(Modifier.fillMaxWidth().testTag("diff")) { DiffFileView(file) }
            }
        }
        val colors = rule.node("diff").paints()
        for ((name, color) in listOf("added row" to 0x12261EL, "added gutter" to 0x1B4721L, "removed row" to 0x25171CL, "removed gutter" to 0x78191BL)) {
            assertTrue("$name ${color.toString(16)}", painted(colors, hex(color)))
        }
        assertTrue("hunk row", painted(rule.onAllNodesWithTag(DiffTags.HUNK, useUnmergedTree = true)[0].paints(), hex(0x161B22)))
        assertFalse("no light added row", painted(colors, hex(0xE6FFEC)))
    }

    @Test
    fun codeBlocksUseTheDarkSurfaceAndSyntax() {
        rule.setHappyContent(dark = true) { MarkdownView(parseMarkdown("```javascript\nconst x = 1\n```"), Modifier.fillMaxWidth()) }
        assertTrue("card on surfaceHighest", painted(rule.node(MarkdownTags.CODE_BLOCK).paints(), hex(0x282828)))
        assertTrue("copy border in divider", painted(rule.node(MarkdownTags.CODE_COPY).paints(), hex(0x2A2A2A)))
        val code = rule.onNodeWithText("const x = 1", useUnmergedTree = true).fetchSemanticsNode()
            .config.getOrNull(SemanticsProperties.Text)!!.single()
        assertTrue("const in syntaxKeyword: ${code.spanStyles}", code.spanStyles.any { it.item.color == hex(0x569CD6) && code.substring(it.start, it.end) == "const" })
    }

    @Test
    fun theContextGaugeInksWhite() {
        rule.setHappyContent(dark = true) { Box(Modifier.padding(4.dp)) { ContextGauge(100) } }
        val colors = rule.node(UsageRowTags.GAUGE).paints()
        assertTrue("full ring in white", painted(colors, Color.White))
        assertFalse("no black ink", painted(colors, Color.Black))
    }

    @Test
    fun theGaugeTrackIsTheDarkDivider() {
        rule.setHappyContent(dark = true) { Box(Modifier.padding(4.dp)) { ContextGauge(0) } }
        assertTrue(painted(rule.node(UsageRowTags.GAUGE).paints(), hex(0x2A2A2A)))
    }

    @Test
    fun theCopyMenuSitsOnTheDarkSurface() {
        rule.setHappyContent(dark = true) { CopyMenuContent(onCopy = {}, onClose = {}) }
        val map = rule.node(CopyMenuTags.COPY).captureToImage().toPixelMap()
        // Left of the icon, clear of the rounded corners.
        val pixel = map[9, map.height / 2]
        assertTrue("surface, got ${Integer.toHexString(pixel.toArgb())}", painted(setOf(pixel.toArgb()), hex(0x161616)))
    }

    @Test
    fun theCliPillKeepsItsYellowInDark() {
        rule.setHappyContent(dark = true) { CliWarningPill(onDismiss = {}) }
        assertTrue(painted(rule.node(SessionNoticeTags.CLI_WARNING).paints(), hex(0xFFF3CD)))
    }

    @Test
    fun theRemoveButtonIsOnTheDarkSurfaceHigh() {
        val image = AttachmentPreview("a", "file:///missing/a.jpg", 10, 10, "image/jpeg", 100, "a.jpg")
        rule.setHappyContent(dark = true) { AttachmentStrip(listOf(image), onRemove = {}) }
        assertTrue(painted(rule.node(AttachmentStripTags.REMOVE).paints(), hex(0x1E1E1E)))
    }

    @Test
    fun theGlassBorderIsGlassBorder() {
        assertEquals(rgba(255, 255, 255, 0.14f), DarkChatColors.glassBorder)
        assertEquals(rgba(255, 255, 255, 0.82f), LightChatColors.glassBorder)
        var dark: Color? = null
        rule.setHappyContent(dark = true) { dark = ChatTheme.colors.glassBorder }
        assertEquals(DarkChatColors.glassBorder, dark)
    }

    @Test
    fun theBotPickerUsesTheDarkSurfaces() {
        rule.setHappyContent(dark = true) {
            Column {
                BotKindHeader(creatingBot = true, onChange = {})
                BotFacePicker(HomeDockBot(true, "Bot", listOf(null, null, null, null), slot = 1, null, null), onPick = {}, onRoll = {}, onOpenUrl = {})
            }
        }
        val segment = rule.node(BotFaceTags.kind(true)).captureToImage().toPixelMap()
        assertTrue("chosen segment on surfaceHighest", painted(setOf(segment[2, segment.height / 2].toArgb()), hex(0x282828)))
        assertTrue("picked face ringed in white", painted(rule.node(BotFaceTags.face(1)).paints(), Color.White))
        assertFalse("unpicked face has no ring", painted(rule.node(BotFaceTags.face(0)).paints(), Color.White))
    }
}
