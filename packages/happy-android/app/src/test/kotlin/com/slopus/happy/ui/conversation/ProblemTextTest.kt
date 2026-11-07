package com.slopus.happy.ui.conversation

import android.content.res.Configuration
import android.content.res.Resources
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Problem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.Locale

/**
 * Failures travel as cases, not sentences: the agent's own words stay as it
 * wrote them, and the phone's are put into words by the UI, in the person's
 * language.
 */
@RunWith(AndroidJUnit4::class)
class ProblemTextTest {
    private fun resources(language: String): Resources {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val configuration = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) }
        return context.createConfigurationContext(configuration).resources
    }

    private val english = resources("en")
    private val russian = resources("ru")

    @Test
    fun describeKeepsTheAgentsWordsAndNamesTheRest() {
        assertEquals(Problem.Link(AgentConnectionException.Reason.Unavailable), Conversation.describe(AgentConnectionException(AgentConnectionException.Reason.Unavailable)))
        assertEquals(Problem.Said("Unknown model."), Conversation.describe(ConversationApiException(400, "bad_request", "Unknown model.")))
        assertEquals(Problem.Refused(409), Conversation.describe(ConversationApiException(409, null, " ")))
        assertEquals(Problem.Said("timeout"), Conversation.describe(IOException("timeout")))
        assertEquals(Problem.Unknown, Conversation.describe(IllegalStateException()))
        // A role's refusal reads in the phone's words, never the server's.
        assertEquals(Problem.Forbidden, Conversation.describe(ConversationApiException(403, "forbidden", "This needs the content.write permission.")))
        assertEquals(Problem.Forbidden, Conversation.describe(com.slopus.happy.agent.AgentApiException(403, "forbidden", "This needs the vaults.manage_access permission.")))
        // A computer's own refusal keeps its words.
        assertEquals(Problem.Said("Only the owner can archive this task."), Conversation.describe(ConversationApiException(403, "forbidden", "Only the owner can archive this task.")))
        assertEquals("You don't have permission to do that.", english.problemText(Problem.Forbidden))
        assertEquals("You don't have permission to do that.", english.refusalText(com.slopus.happy.agent.IntentRefusal.FORBIDDEN))
        assertEquals("Busy.", english.refusalText("Busy."))
    }

    @Test
    fun problemsReadInThePersonsLanguage() {
        assertEquals("Unknown model.", english.problemText(Problem.Said("Unknown model.")))
        assertEquals("Unknown model.", russian.problemText(Problem.Said("Unknown model.")))
        assertEquals("The agent refused this (409).", english.problemText(Problem.Refused(409)))
        assertEquals("Something went wrong.", english.problemText(Problem.Unknown))
        assertEquals("Couldn't read the pictures to send.", english.problemText(Problem.PicturesUnreadable))
        assertEquals("Could not reach the agent. Check its connection and try again.", english.problemText(Problem.Link(AgentConnectionException.Reason.Unavailable)))
        for (problem in listOf(Problem.Refused(409), Problem.Unknown, Problem.PicturesUnreadable, Problem.Link(AgentConnectionException.Reason.Revoked))) {
            assertNotEquals(problem.toString(), english.problemText(problem), russian.problemText(problem))
        }
        assert(russian.problemText(Problem.Refused(409)).contains("409"))
    }

    private fun failure(json: String, text: String = ""): FailureReason? {
        val message = Message(
            "f1", "service", 1, if (text.isEmpty()) emptyList() else listOf(Block.Text(text)),
            failure = Json.parseToJsonElement(json).jsonObject,
        )
        return ConversationRowBuilder.failureOf(message)?.reason
    }

    @Test
    fun everyFailureKindIsACase() {
        val claude = """"provider":{"vendorName":"Claude","label":"Claude Code"}"""
        assertEquals(FailureReason.SignInMissing("Claude Code", "claude login"), failure("""{"kind":"signin_missing",$claude,"product":"Claude Code","command":"claude login"}"""))
        assertEquals(FailureReason.CannotAuthenticate("Claude Code"), failure("""{"kind":"signin_missing",$claude}"""))
        assertEquals(FailureReason.UsageLimit("Claude"), failure("""{"kind":"usage_limit",$claude}"""))
        assertEquals(FailureReason.NoAccountAvailable("Team"), failure("""{"kind":"no_account_available","poolName":"Team"}"""))
        assertEquals(FailureReason.RateLimited("Claude"), failure("""{"kind":"rate_limited",$claude}"""))
        assertEquals(FailureReason.ProviderUnavailable("Claude"), failure("""{"kind":"provider_unavailable",$claude}"""))
        assertEquals(FailureReason.Network("Claude"), failure("""{"kind":"network",$claude}"""))
        assertEquals(FailureReason.ContextTooLong("opus-5"), failure("""{"kind":"context_too_long","modelId":"opus-5"}"""))
        assertEquals(FailureReason.ProviderDisabled("Claude Code"), failure("""{"kind":"provider_disabled",$claude}"""))
        assertEquals(FailureReason.Internal("disk full"), failure("""{"kind":"internal","detail":"disk full"}"""))
        // The daemon's own words where the kind brings no names: the message's text, else the failure's.
        assertEquals(FailureReason.Said("It broke."), failure("""{"kind":"usage_limit"}""", text = "It broke."))
        assertEquals(FailureReason.Said("from the daemon"), failure("""{"kind":"something_new","message":"from the daemon"}"""))
        assertEquals(FailureReason.Unknown, failure("""{"kind":"usage_limit"}"""))
        assertNull(ConversationRowBuilder.failureOf(Message("m", "agent", 1, emptyList())))
    }

    @Test
    fun failuresReadInThePersonsLanguage() {
        assertEquals("Claude usage limit reached.", english.failureText(FailureReason.UsageLimit("Claude")))
        assertEquals("Claude Code isn't signed in. Run `claude login`, then retry.", english.failureText(FailureReason.SignInMissing("Claude Code", "claude login")))
        assertEquals("Every account in “Team” is out of usage.", english.failureText(FailureReason.NoAccountAvailable("Team")))
        assertEquals("Something went wrong: disk full", english.failureText(FailureReason.Internal("disk full")))
        assertEquals("It broke.", russian.failureText(FailureReason.Said("It broke.")))
        val ru = russian.failureText(FailureReason.SignInMissing("Claude Code", "claude login"))
        assert(ru.contains("Claude Code") && ru.contains("`claude login`")) { ru }
        assertNotEquals(english.failureText(FailureReason.UsageLimit("Claude")), russian.failureText(FailureReason.UsageLimit("Claude")))
    }
}
