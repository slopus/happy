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
    private fun reply(quote: String, from: String = "me") = Message.parse(
        Json.parseToJsonElement("""{"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Looks great!"}],"metadata":{"userId":"$from"},"quote":$quote}"""),
    )!!

    private fun row(message: Message, references: References? = null) =
        ConversationRowBuilder.build(message, "a1", null, false, references = references).single() as ConversationRow.User

    @Test fun `an agent's story is quoted by its name and frame`() {
        val message = reply("""{"kind":"story","storyId":"s1","agentId":"a1","userId":null,"caption":"Launch day","expiresAt":2,"frame":{"mimeType":"image/jpeg","thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}}""")
        val row = row(message, References(agents = mapOf("a1" to References.Entity("Scout", "a1"))))
        assertEquals("Looks great!", row.text)
        assertEquals(ConversationRow.StoryQuote("a1", "a1", person = false, author = "Scout", frame = true, thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"), row.story)
    }

    @Test fun `a person's repost is theirs, and without a frame it says so`() {
        val message = reply("""{"kind":"story","storyId":"s1","agentId":"a1","userId":"u7","caption":null,"expiresAt":2,"frame":null}""")
        assertEquals(ConversationRow.StoryQuote("a1", "u7", person = true, author = "Ana", frame = false), row(message, References(users = mapOf("u7" to "Ana"))).story)
        // Not yet named.
        assertNull(row(message).story?.author)
    }

    @Test fun `a teammate's reply names them, and the reader's own names no one`() {
        val story = """{"kind":"story","storyId":"s1","agentId":"a1","userId":null,"caption":null,"expiresAt":2,"frame":null}"""
        val references = References(users = mapOf("u7" to "Ana"), me = "me")
        assertEquals(ConversationRow.Sender("u7", "Ana"), row(reply(story, from = "u7"), references).sender)
        assertNull(row(reply(story), references).sender)
        // Until the reader is known, every message is theirs.
        assertNull(row(reply(story, from = "u7")).sender)
    }

    @Test fun `a quote of a kind this build doesn't know quotes nothing`() {
        val message = reply("""{"kind":"poll","pollId":"p1"}""")
        assertNull(row(message).story)
        assertEquals("Looks great!", row(message).text)
    }

    @Test fun `the quote and its writer are kept with the conversation`() {
        val message = reply("""{"kind":"story","storyId":"s1","agentId":"a1","userId":null,"caption":"Launch day","expiresAt":2,"frame":{"mimeType":"image/jpeg"}}""")
        assertEquals("me", message.userId)
        assertEquals(message, Message.parse(KeptConversation.messageJson(message)))
    }
}
