package com.slopus.happy.agent

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** Whether GitHub is linked, from the cluster's Git credentials, for `github_connect`. */
@OptIn(ExperimentalCoroutinesApi::class)
class GitCredentialsTest {
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test fun `the person's own credential names the account, else the team's, else none`() {
        assertEquals(GithubLink.None, GithubLink.of(json("""{"credentials":[]}""")))
        assertEquals(
            GithubLink.Linked("ada"),
            GithubLink.of(json("""{"credentials":[{"id":"g1","name":"Team bot","shared":true,"username":"acme-bot"},{"id":"g2","name":"GitHub","shared":false,"username":"ada"}]}""")),
        )
        assertEquals(GithubLink.Linked("Team bot"), GithubLink.of(json("""{"credentials":[{"id":"g1","name":"Team bot","shared":true}]}""")))
    }

    @Test fun `read again on a credential event`() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 4)
        var answer: GithubLink = GithubLink.None
        var reads = 0
        val link = GithubLinkSource({ reads++; answer }, events, backgroundScope).follow()
        runCurrent()
        assertEquals(GithubLink.None, link.value)
        answer = GithubLink.Linked("ada")
        events.emit(AgentEvent("c1", "member.updated", JsonObject(emptyMap())))
        runCurrent()
        assertEquals(GithubLink.None, link.value)
        events.emit(AgentEvent("c2", "gitCredential.created", JsonObject(emptyMap())))
        runCurrent()
        assertEquals(GithubLink.Linked("ada"), link.value)
        assertEquals(2, reads)
    }
}
