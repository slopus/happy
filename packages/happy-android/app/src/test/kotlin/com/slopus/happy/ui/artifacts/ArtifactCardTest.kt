package com.slopus.happy.ui.artifacts

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.references.References
import kotlinx.coroutines.awaitCancellation
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.conversation.ConversationRowView
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A conversation's artifact card, as iOS's `ChatMediaPlan.card(artifact:)` and desktop's `ArtifactTypeGlyph` draw it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ArtifactCardTest {
    @get:Rule val rule = createComposeRule()

    @Test fun theGlyphFollowsTheType() {
        assertEquals(Ionicon.DocumentTextOutline, artifactCardGlyph("markdown"))
        assertEquals(Ionicon.GlobeOutline, artifactCardGlyph("html"))
        assertEquals(Ionicon.ImageOutline, artifactCardGlyph("image"))
        assertEquals(Ionicon.Images, artifactCardGlyph("image_series"))
        assertEquals(Ionicon.Videocam, artifactCardGlyph("video"))
        assertEquals(Ionicon.DocumentOutline, artifactCardGlyph("document"))
        assertEquals(Ionicon.CubeOutline, artifactCardGlyph("chart"))
    }

    @Test fun aCreationNamesItsKindAChangeItsVersion() {
        val opened = ArrayList<String>()
        rule.setHappyContent {
            val actions = ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }, onOpenArtifact = { opened += it.artifactId })
            Column {
                ConversationRowView(ConversationRow.Artifact("r1", "a1", "Release notes", "markdown", 1), userMessageBubblePalette(null, false), actions)
                ConversationRowView(ConversationRow.Artifact("r2", "a2", "", "image_series", 3, "latest"), userMessageBubblePalette(null, false), actions)
            }
        }
        rule.onNodeWithText("Markdown").assertExists()
        rule.onNodeWithText("Untitled artifact").assertExists()
        rule.onNodeWithText("Image series · Version 3").assertExists()
        rule.onNodeWithText("Release notes").performClick()
        assertEquals(listOf("a1"), opened)
    }

    /** iOS `InlinePageView`: an HTML artifact that asks to be inline draws its page under its card, 120 until it measures itself. */
    @Test fun anInlinePageSitsUnderItsCardAndGrowsToItsHeight() {
        val asked = ArrayList<Pair<String, References.Page>>()
        val pages = InlinePages(prepare = { id, page -> asked += id to page; awaitCancellation() }, onOpen = {})
        val page = References.Page(2, "index.html")
        rule.setHappyContent {
            val actions = ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }, onOpenArtifact = {}, pages = pages)
            Column {
                ConversationRowView(ConversationRow.Artifact("r1", "p1", "Voice waveform", "html", 2, "latest", page = page), userMessageBubblePalette(null, false), actions)
                ConversationRowView(ConversationRow.Artifact("r2", "p2", "Plain page", "html", 1, "latest"), userMessageBubblePalette(null, false), actions)
            }
        }
        rule.onNodeWithText("Voice waveform").assertExists()
        val node = rule.onNodeWithTag(ArtifactInlinePageTags.PAGE)
        node.assertHeightIsEqualTo(InlinePages.DEFAULT_HEIGHT)
        assertEquals(listOf("p1" to page), asked)
        assertEquals("Voice waveform", node.fetchSemanticsNode().config[SemanticsProperties.ContentDescription].single())
        pages.measured("p1", 312.4f)
        rule.waitForIdle()
        node.assertHeightIsEqualTo(313.dp)
        // Measured again at the same height, in whatever fraction, it stays.
        pages.measured("p1", 312.9f)
        assertEquals(313.dp, pages.height("p1"))
    }

    @Test fun anInlinePageThatCantBeReachedSaysSo() {
        val pages = InlinePages(prepare = { _, _ -> throw IllegalStateException("offline") }, onOpen = {})
        rule.setHappyContent {
            ArtifactInlinePage("p1", "", References.Page(1, "index.html"), pages)
        }
        rule.waitForIdle()
        val config = rule.onNodeWithTag(ArtifactInlinePageTags.PAGE).fetchSemanticsNode().config
        assertEquals(ArtifactInlinePageTags.UNAVAILABLE, config[SemanticsProperties.StateDescription])
        assertEquals("Untitled artifact", config[SemanticsProperties.ContentDescription].single())
    }

    @Test fun theHostsPropertiesAndTheArtifactsOwnBackground() {
        assertEquals(Color(0xFF0B0B0F), cssColor("#0b0b0f"))
        assertEquals(Color(0xFFAABBCC), cssColor("#abc"))
        assertEquals(Color(0x80112233), cssColor("#11223380"))
        val script = hostScript(com.slopus.happy.ui.theme.DarkColors)
        assertTrue(script, script.contains("--happy-host-color-scheme', \"dark\""))
        assertTrue(script, script.contains("--happy-host-surface', \"transparent\""))
        assertTrue(script, script.contains("--happy-host-page-inset', \"0\""))
        assertTrue(script, script.contains("s.colorScheme = 'dark'"))
    }
}
