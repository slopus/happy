package com.slopus.happy.conversation

import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.ui.connection.SettingsLinks
import org.junit.Assert.assertEquals
import org.junit.Test

/** A conversation's settings links follow its connection: a page it hasn't reads as the link's words, inline or as a button. */
class ConversationSettingsLinksTest {
    private val words = "Add [providers](happy://settings/providers) or open [General](happy://settings/general).\n" +
        "[Roles](happy://settings/roles \"button\") [Voice](happy://settings/voice \"button\")"

    private fun rows(cloud: Boolean, streaming: Boolean = false): List<MarkdownBlock> {
        val message = Message("m", "agent", 1, listOf(Block.Text(words)))
        val hasPage = { page: String -> SettingsLinks.place(page, "https://acme.${com.slopus.happy.BuildConfig.HAPPY_CLOUD_BASE}", cloud) != null }
        val builder = ConversationRowBuilder().apply { this.hasPage = hasPage }
        val row = builder.rows(message, "a1", null, streaming).single() as ConversationRow.Text
        return row.live?.content?.value?.blocks ?: row.blocks
    }

    private fun span(text: String, url: String? = null, button: Boolean = false) = MarkdownSpan(emptySet(), text, url, button)

    @Test fun `on a connection without the page a link is its words`() {
        for (streaming in listOf(false, true)) {
            assertEquals(
                listOf(
                    MarkdownBlock.Text(listOf(span("Add "), span("providers"), span(" or open "), span("General", "happy://settings/general"), span("."))),
                    MarkdownBlock.Text(listOf(span("Roles"))),
                    MarkdownBlock.Buttons(listOf(span("Voice", "happy://settings/voice", button = true))),
                ),
                rows(cloud = false, streaming = streaming),
            )
        }
    }

    @Test fun `where the connection has every page every link stays`() {
        assertEquals(
            listOf(
                MarkdownBlock.Text(listOf(span("Add "), span("providers", "happy://settings/providers"), span(" or open "), span("General", "happy://settings/general"), span("."))),
                MarkdownBlock.Buttons(listOf(span("Roles", "happy://settings/roles", button = true), span("Voice", "happy://settings/voice", button = true))),
            ),
            rows(cloud = true),
        )
    }
}
