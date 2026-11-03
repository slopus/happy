package com.slopus.happy.ui.artifacts

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.junit4.createComposeRule
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
}
