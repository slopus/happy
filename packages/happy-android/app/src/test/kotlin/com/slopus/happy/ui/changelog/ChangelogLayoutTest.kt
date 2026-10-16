package com.slopus.happy.ui.changelog

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * happy-app app/(app)/changelog.tsx. Header: "What's New" with a 40x40
 * picture 6 after it, centred in the bar. One group per release: the
 * release title (20/28 semibold, as written, not uppercased) 16 below the
 * previous card and 24 in; a card inset 16 from the screen holding the
 * summary (16/23, 16 below it) and the notes as markdown, padded 16, 14
 * on top. Opening marks the latest title viewed. No entries: "No
 * changelog entries available.", centred.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChangelogLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val changelog = Changelog(
        entries = listOf(
            ChangelogEntry("May 13 - Faster long chats", "Thanks [@a](https://github.com/a) for this.", "- **One** - first\n- Two"),
            ChangelogEntry("May 12 - Hello world", "First release.", ""),
        ),
        latestTitle = "May 13 - Faster long chats",
    )

    @Test
    fun entriesAreCardsTitledWithTheRelease() {
        var viewed: String? = null
        rule.setHappyContent { ChangelogScreen(changelog, onViewed = { viewed = it }, onBack = {}) }
        rule.waitForIdle()
        assertEquals("May 13 - Faster long chats", viewed)

        rule.onNodeWithText("What's New").assertIsDisplayed()
        val bar = rule.node(HeaderTags.BAR).bounds
        val image = rule.node(ChangelogTags.HEADER_IMAGE).bounds
        assertBox("header picture", image, image.left, bar.top + 12.dp, 40.dp, 40.dp)
        val headerTitle = rule.onNodeWithText("What's New", useUnmergedTree = true).bounds
        assertDp("picture 6 after the title", 6, image.left - headerTitle.right)

        rule.onNodeWithText("May 13 - Faster long chats").assertIsDisplayed()
        val titles = rule.onAllNodesWithTag(ChangelogTags.TITLE, useUnmergedTree = true)
        val cards = rule.onAllNodesWithTag(ChangelogTags.CARD, useUnmergedTree = true)
        val title = titles[0].bounds
        val card = cards[0].bounds
        assertDp("title 24 into a group inset 4", 28, title.left)
        assertDp("title 28 high", 28, title.bottom - title.top)
        assertDp("title 8 above the card", 8, card.top - title.bottom)
        assertBox("card", card, 16.dp, card.top, (PHONE_WIDTH - 32).dp, card.bottom - card.top)
        val summary = rule.onAllNodesWithTag(ChangelogTags.SUMMARY, useUnmergedTree = true)[0].bounds
        assertDp("summary 14 into the card", 14, summary.top - card.top)
        assertDp("summary 16 in", 16, summary.left - card.left)
        rule.onNodeWithText("One - first", substring = true).assertIsDisplayed()

        val second = titles[1].bounds
        assertDp("next title 16 below the card", 16, second.top - card.bottom)
        assertTrue(second.top > card.bottom)
        rule.onNodeWithText("First release.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun emptyChangelog() {
        var viewed: String? = null
        rule.setHappyContent { ChangelogScreen(Changelog.Empty, onViewed = { viewed = it }, onBack = {}) }
        rule.onNodeWithText("No changelog entries available.").assertIsDisplayed()
        val text = rule.node(ChangelogTags.EMPTY).bounds
        assertDp("centred", (PHONE_WIDTH / 2f).dp, (text.left + text.right) / 2)
        assertEquals(null, viewed)
    }
}
