package com.slopus.happy.conversation

import com.slopus.happy.references.References
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A person's reply to a story (iOS `ChatItem.story`): the message quotes
 * the story in its `quote`, and its row shows that above the words, which
 * are what the person typed.
 */
class StoryReplyRowsTest {
    private fun reply(quote: String) = Message.parse(
        Json.parseToJsonElement("""{"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Looks great!"}],"quote":$quote}"""),
    )!!

    private fun row(message: Message, references: References? = null) =
        ConversationRowBuilder.build(message, "a1", null, false, references = references).single() as ConversationRow.User

    @Test fun `an agent's story is quoted by its name with its caption and frame`() {
        val message = reply("""{"kind":"story","storyId":"s1","agentId":"a1","userId":null,"caption":"Launch day","expiresAt":2,"frame":{"mimeType":"image/jpeg","thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}}""")
        val row = row(message, References(agents = mapOf("a1" to References.Entity("Scout", "a1"))))
        assertEquals("Looks great!", row.text)
        assertEquals(ConversationRow.StoryQuote("a1", "a1", person = false, author = "Scout", caption = "Launch day", frame = true, thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"), row.story)
    }

    @Test fun `a person's repost is theirs, and without a frame or caption it says so`() {
        val message = reply("""{"kind":"story","storyId":"s1","agentId":"a1","userId":"u7","caption":null,"expiresAt":2,"frame":null}""")
        assertEquals(ConversationRow.StoryQuote("a1", "u7", person = true, author = "Ana", caption = null, frame = false), row(message, References(users = mapOf("u7" to "Ana"))).story)
        // Not yet named.
        assertNull(row(message).story?.author)
    }

    @Test fun `a quote of a kind this build doesn't know quotes nothing`() {
        val message = reply("""{"kind":"poll","pollId":"p1"}""")
        assertNull(row(message).story)
        assertEquals("Looks great!", row(message).text)
    }

    @Test fun `the quote is kept with the conversation`() {
        val message = reply("""{"kind":"story","storyId":"s1","agentId":"a1","userId":null,"caption":"Launch day","expiresAt":2,"frame":{"mimeType":"image/jpeg"}}""")
        assertEquals(message, Message.parse(KeptConversation.messageJson(message)))
    }
}
