package com.slopus.happy.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-app's sync/agentCommunications.spec.ts. */
class AgentCommunicationsTest {
    private val q = """{"id":"q1","header":"Storage","question":"Where should it live?","options":[{"label":"Settings"},{"label":"Locally"}]}"""
    private fun question(extra: String = "", id: String = "q1") =
        """{"id":"$id","header":"Storage","question":"Where should it live?","options":[{"label":"Settings"},{"label":"Locally"}]$extra}"""
    private fun state(communications: String, completed: String = "null") =
        agentState("""{"communications":$communications,"completedCommunications":$completed}""")
    private fun parsed(text: String) = AgentQuestion.parse(json(text).obj!!)!!
    private fun draft(vararg options: String, custom: String = "") = AgentQuestionDraft(options.toList(), custom)

    @Test fun `reads the questions of a pending form`() {
        val pending = selectPendingCommunications(state("""{"call-1":{"kind":"form","createdAt":5,"form":{"questions":[$q]}}}"""))
        val form = pending.single() as PendingAgentCommunication.Form
        assertEquals("call-1", form.id)
        assertEquals("Storage", form.questions[0].header)
    }

    @Test fun `keeps the provider tool id`() {
        val pending = selectPendingCommunications(state("""{"c":{"kind":"form","toolUseId":"tool-call-1","form":{"questions":[$q]}}}"""))
        assertEquals("tool-call-1", pending.single().toolUseId)
    }

    @Test fun `surfaces an unknown kind instead of dropping it`() {
        assertEquals(
            listOf(PendingAgentCommunication.Unsupported("call-1", 1, null, "file_pick", "Pick a file")),
            selectPendingCommunications(state("""{"call-1":{"kind":"file_pick","createdAt":1,"title":"Pick a file"}}""")),
        )
        assertNull((selectPendingCommunications(state("""{"call-1":{"kind":"diff_review","createdAt":1}}""")).single() as PendingAgentCommunication.Unsupported).title)
    }

    @Test fun `skips completed, empty and unanswerable forms`() {
        assertEquals(emptyList<Any>(), selectPendingCommunications(state("""{"call-1":{"kind":"form","form":{"questions":[$q]}}}""", """{"call-1":{"kind":"form","status":"answered"}}""")))
        assertEquals(emptyList<Any>(), selectPendingCommunications(state("""{"call-1":{"kind":"form","form":{"questions":[]}}}""")))
        assertEquals(emptyList<Any>(), selectPendingCommunications(state("""{"call-1":{"kind":"form","form":{"questions":[{"id":"q1","header":"h","question":"q","allowCustom":false,"options":[]}]}}}""")))
        assertEquals(1, selectPendingCommunications(state("""{"call-1":{"kind":"form","form":{"questions":[{"id":"q1","header":"h","question":"q","allowCustom":true,"options":[]}]}}}""")).size)
        assertEquals(emptyList<Any>(), selectPendingCommunications(null))
    }

    @Test fun `orders communications oldest first`() {
        val pending = selectPendingCommunications(state("""{"b":{"kind":"form","createdAt":20,"form":{"questions":[$q]}},"a":{"kind":"form","createdAt":10,"form":{"questions":[$q]}}}"""))
        assertEquals(listOf("a", "b"), pending.map { it.id })
    }

    @Test fun `joins a form to its tool call`() {
        val pending = selectAgentFormCommunication(state("""{"communication-1":{"kind":"form","toolUseId":"tool-call-1","form":{"questions":[$q]}}}"""), "tool-call-1")!!
        assertEquals("communication-1", pending.id)
        assertEquals(AgentFormStatus.Pending, pending.status)
        assertEquals("tool-call-1", selectAgentFormCommunication(state("""{"tool-call-1":{"kind":"form","form":{"questions":[$q]}}}"""), "tool-call-1")?.id)
        val answered = selectAgentFormCommunication(
            state(
                """{"communication-1":{"kind":"form","toolUseId":"tool-call-1","form":{"questions":[$q]}}}""",
                """{"communication-1":{"kind":"form","toolUseId":"tool-call-1","form":{"questions":[$q]},"status":"answered","answers":{"q1":{"options":["Settings"]}}}}""",
            ),
            "tool-call-1",
        )!!
        assertEquals(AgentFormStatus.Answered, answered.status)
        assertEquals(mapOf("q1" to AgentQuestionAnswer(listOf("Settings"))), answered.answers)
    }

    @Test fun `choice forms render inline, text-only forms use the modal`() {
        val choice = PendingAgentCommunication.Form("choice", 0, null, listOf(parsed(question())))
        val text = PendingAgentCommunication.Form("text", 0, null, listOf(parsed("""{"id":"q1","header":"h","question":"q","options":[],"allowCustom":true}""")))
        assertTrue(canRenderAgentFormInline(choice))
        assertFalse(canRenderAgentFormInline(text))
        assertFalse(shouldUseAgentQuestionFallback(choice))
        assertTrue(shouldUseAgentQuestionFallback(text))
    }

    @Test fun `toggling options`() {
        assertEquals(listOf("Locally"), toggleOption(toggleOption(draft(), "Settings", false), "Locally", false).options)
        var multi = toggleOption(draft(), "Settings", true)
        multi = toggleOption(multi, "Locally", true)
        assertEquals(listOf("Settings", "Locally"), multi.options)
        assertEquals(listOf("Locally"), toggleOption(multi, "Settings", true).options)
        assertEquals(emptyList<String>(), toggleOption(draft("Settings"), "Settings", false).options)
        assertEquals("mine", toggleOption(draft(custom = "mine"), "Settings", false).custom)
    }

    @Test fun `answered and submittable`() {
        val question = parsed(question())
        assertTrue(isQuestionAnswered(question, draft("Settings")))
        assertTrue(isQuestionAnswered(question, draft(custom = "mine")))
        assertFalse(isQuestionAnswered(question, draft(custom = "  ")))
        assertFalse(isQuestionAnswered(question, null))
        assertTrue(isQuestionAnswered(parsed(question(""","required":false""")), null))
        val questions = listOf(question, parsed(question(id = "q2")))
        assertFalse(canSubmit(questions, mapOf("q1" to draft("Settings"))))
        assertTrue(canSubmit(questions, mapOf("q1" to draft("Settings"), "q2" to draft(custom = "written"))))
    }

    @Test fun `building answers`() {
        assertEquals(
            mapOf("q1" to AgentQuestionAnswer(listOf("Settings"), "something else")),
            buildAnswers(listOf(parsed(question(""","allowCustom":true"""))), mapOf("q1" to draft("Settings", custom = " something else "))),
        )
        assertEquals(mapOf("q1" to AgentQuestionAnswer(listOf("Settings"))), buildAnswers(listOf(parsed(question())), mapOf("q1" to draft("Settings", "Locally"))))
        assertEquals(
            mapOf("q1" to AgentQuestionAnswer(listOf("Settings", "Locally"))),
            buildAnswers(listOf(parsed(question(""","multiSelect":true"""))), mapOf("q1" to draft("Settings", "Locally"))),
        )
        assertEquals(emptyMap<String, AgentQuestionAnswer>(), buildAnswers(listOf(parsed(question())), mapOf("q1" to draft(custom = " "))))
    }

    @Test fun `describing answers`() {
        assertEquals("Settings, and more", describeAnswer(AgentQuestionAnswer(listOf("Settings"), "and more")))
        assertEquals("—", describeAnswer(null))
        assertEquals("—", describeAnswer(AgentQuestionAnswer()))
    }
}
