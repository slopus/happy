package com.slopus.happy.conversation

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A question read from its call (iOS 7f6355041 `Question.asked`), and the ticks a waiting one keeps. */
class QuestionAskedTest {
    private fun args(text: String) = Json.parseToJsonElement(text)

    private val batch = args(
        """{"context":"Billing needs storage.","questions":[
            {"id":"db","header":"Database","question":"Which database?","options":[{"label":"Postgres","description":"Matches the stack."},{"label":"SQLite"}]},
            {"header":"Extras","question":"What else?","multiSelect":true,"options":[{"label":"Backups, nightly"},{"label":"Metrics"}]}
        ]}""",
    )

    @Test fun `a call still asking is pending, numbered as the daemon numbers it`() {
        val q = Question.asked("q1", batch, null)!!
        assertEquals("pending", q.status)
        assertEquals("Billing needs storage.", q.context)
        assertEquals(listOf("db", "question_2"), q.prompts.map { it.id })
        assertTrue(q.prompts[1].multiSelect)
        assertEquals("Matches the stack.", q.prompts[0].options[0].description)
    }

    @Test fun `one question may come bare, and options as choices`() {
        val q = Question.asked("q1", args("""{"question":"Ship?","options":{"choices":[{"label":"Yes"},{"label":"No"}],"multiSelect":false}}"""), null)!!
        assertEquals("question_1", q.prompts.single().id)
        assertEquals(listOf("Yes", "No"), q.prompts.single().options.map { it.label })
    }

    @Test fun `the result says how it was answered, labels with commas read whole`() {
        val output = "Request q1:\nWhich database?\nStatus: Answered\nAnswer:\ndb: Selected: Postgres\nquestion_2: Selected: Backups, nightly, Metrics\nand alerts too"
        val q = Question.asked("q1", batch, output)!!
        assertEquals("answered", q.status)
        assertEquals(listOf("Postgres"), q.answers!!["db"])
        assertEquals(listOf("Backups, nightly", "Metrics", "and alerts too"), q.answers!!["question_2"])
    }

    @Test fun `a single question's answer carries no id`() {
        val q = Question.asked("q1", args("""{"question":"Ship?"}"""), "Request q1:\nShip?\nStatus: Answered\nAnswer:\nYes, today")!!
        assertEquals(mapOf("question_1" to listOf("Yes, today")), q.answers)
    }

    @Test fun `a result that isn't an answer is cancelled, and no arguments is no question`() {
        assertEquals("canceled", Question.asked("q1", batch, "Request q1:\nStatus: Cancelled\nReason: stopped")!!.status)
        assertNull(Question.asked("q1", null, null))
        assertNull(Question.asked("q1", args("""{"questions":[]}"""), null))
    }

    @Test fun `a tick is one alone or one more of many, taken back when picked again`() {
        val q = Question.asked("q1", batch, null)!!
        var picked = q.picking(emptyMap(), "db", "Postgres")
        picked = q.picking(picked, "db", "SQLite")
        assertEquals(listOf("SQLite"), picked["db"])
        picked = q.picking(picked, "question_2", "Metrics")
        picked = q.picking(picked, "question_2", "Backups, nightly")
        assertEquals(listOf("Metrics", "Backups, nightly"), picked["question_2"])
        assertTrue(q.complete(picked))
        picked = q.picking(picked, "question_2", "Metrics")
        picked = q.picking(picked, "question_2", "Backups, nightly")
        assertFalse(q.complete(picked))
    }

    @Test fun `an answered call's card reads as the question answered, and keeps on disk`() {
        val block = Block.parse(
            Json.parseToJsonElement(
                """{"type":"tool_call","id":"q1","name":"request_user_input","status":"completed",
                "arguments":{"context":"Billing.","questions":[{"id":"db","question":"Which?","options":[{"label":"Postgres","description":"x"}]}]},
                "result":{"output":"Request q1:\nStatus: Answered\nAnswer:\ndb: Selected: Postgres"},
                "presentation":{"type":"user_input","questions":[{"id":"db","header":"Database","question":"Which?","multiSelect":false,"options":[{"label":"Postgres","description":"Matches."}]}],"answers":{"db":["Postgres","and nightly backups"]}}}""",
            ),
        ) as Block.ToolCall
        val message = Message("m", "agent", 1, listOf(block))
        fun ask(m: Message) = ConversationRowBuilder.build(m, "a1", null, false).single() as ConversationRow.Ask
        val row = ask(message)
        assertEquals(AskPhase.Answered, row.phase)
        assertEquals("Billing.", row.question.context)
        assertEquals(listOf("Postgres", "and nightly backups"), row.question.answers!!["db"])
        assertEquals("Matches.", row.question.prompts.single().options.single().description)
        val kept = KeptConversation.parse(KeptConversation(listOf(Run("r", "completed", 1, listOf(message))), emptyList(), false, null, null).json())!!
        val again = kept.runs.single().messages.single()
        assertEquals(row, ask(again))
        assertEquals((again.content.single() as Block.ToolCall).output, block.output)
    }

    @Test fun `typed words answer each prompt nothing was ticked on`() {
        val q = Question.asked("q1", batch, null)!!
        val answer = q.answers(mapOf("db" to listOf("Postgres")), "Nothing else")
        assertEquals(mapOf("db" to listOf("Postgres"), "question_2" to listOf("Nothing else")), answer.answers)
        assertTrue(answer.textUsed)
        val ticked = q.answers(mapOf("db" to listOf("Postgres"), "question_2" to listOf("Metrics")), "Thanks")
        assertFalse(ticked.textUsed)
    }
}
