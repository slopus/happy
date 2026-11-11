package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.height
import androidx.compose.foundation.ScrollState
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A code block of a thousand lines is as tall as its text from the first
 * frame, and composes only the chunks near the window, before and after
 * it is scrolled to its end.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class LongCodeBlockTest {
    @get:Rule
    val rule = createComposeRule()

    private val code = (0 until 1000).joinToString("\n") { "val line$it = $it" }

    /** The texts holding code: the whole text and the block's composed chunks. */
    private fun texts(): Int = rule.onAllNodes(hasText("val line", substring = true), useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun aLongBlockIsAsTallAsItsTextAndComposesOnlyChunksNearTheWindow() {
        val scroll = ScrollState(0)
        rule.setHappyContent {
            Column(Modifier.verticalScroll(scroll)) {
                MarkdownView(listOf(MarkdownBlock.CodeBlock(null, code)))
                Text(code, style = MarkdownSpec.codeText, softWrap = false, modifier = Modifier.testTag("whole"))
            }
        }
        val block = rule.node(MarkdownTags.CODE_BLOCK).bounds
        val whole = rule.node("whole").bounds
        // The block is its text, 16 padding above and below.
        assertDp("block height", whole.height + MarkdownSpec.codePadding * 2, block.height)
        val chunks = texts() - 1
        assertTrue("$chunks of ${1000 / CODE_CHUNK_LINES} chunks composed", chunks in 1..6)

        // Scrolled to the block's foot: its last chunk is composed, its first is not.
        val foot = with(rule.density) { block.bottom.roundToPx() }
        rule.runOnIdle { runBlocking { scroll.scrollTo(foot - scroll.viewportSize) } }
        rule.waitForIdle()
        // Each line is also in the whole text below the block.
        val holding = { line: String -> rule.onAllNodes(hasText(line, substring = true), useUnmergedTree = true).fetchSemanticsNodes().size }
        assertEquals("the last chunk is composed", 2, holding("val line999 ="))
        assertEquals("the first chunk is not", 1, holding("val line0 ="))
        assertDp("still as tall", block.height, rule.node(MarkdownTags.CODE_BLOCK).bounds.height)
    }
}
