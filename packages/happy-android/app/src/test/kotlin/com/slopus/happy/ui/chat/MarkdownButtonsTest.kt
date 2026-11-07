package com.slopus.happy.ui.chat

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.browser.LinkOpener
import com.slopus.happy.ui.browser.ProvideLinks
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Happy links titled `button` (API.md, "Buttons"): a button each under the paragraph, or their words where they open nothing. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class MarkdownButtonsTest {
    @get:Rule
    val rule = createComposeRule()

    private val blocks = parseMarkdown(
        "Set things up:\n[Add your team's tokens](happy://settings/providers \"button\") [Roles](happy://settings/roles \"button\")",
    )

    private fun show(opens: (String) -> Boolean, taps: MutableList<String>) {
        val opener = LinkOpener(proxied = true, computer = "Studio", tap = { taps += it }, inApp = {}, external = {}, opensUrl = opens)
        rule.setHappyContent { ProvideLinks(opener) { MarkdownView(blocks) } }
    }

    @Test
    fun eachButtonOpensItsLink() {
        val taps = mutableListOf<String>()
        show({ true }, taps)
        rule.onAllNodesWithTag(MarkdownTags.BUTTON).assertCountEquals(2)
        rule.onNodeWithText("Add your team's tokens").performClick()
        rule.onNodeWithText("Roles").performClick()
        assertEquals(listOf("happy://settings/providers", "happy://settings/roles"), taps)
    }

    @Test
    fun aButtonThatOpensNothingIsItsWords() {
        val taps = mutableListOf<String>()
        show({ it == "happy://settings/providers" }, taps)
        rule.onAllNodesWithTag(MarkdownTags.BUTTON).assertCountEquals(1)
        rule.onNodeWithTag(MarkdownTags.BUTTON_INERT).performClick()
        assertEquals(emptyList<String>(), taps)
    }
}
