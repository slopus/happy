package com.slopus.happy.agent

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The provider CLI object (API.md "Provider CLIs") and its live copy for chat UI. */
@OptIn(ExperimentalCoroutinesApi::class)
class ProviderClisTest {
    @Test fun `reads the object as API md shows it`() {
        val cli = ProviderCli.parse(json("""{"providerCli":${cli("01a", signIn = "signed_in")}}"""))!!
        assertEquals("claude", cli.id)
        assertEquals("Claude Code", cli.name)
        assertTrue(cli.installed)
        assertEquals("2.1.312", cli.installedVersion)
        assertEquals(ProviderCli.Installer("curl -fsSL https://claude.ai/install.sh | bash", "claude.ai"), cli.installer)
        assertEquals(ProviderCli.SignIn.SignedIn, cli.signIn)
        assertEquals("ada@example.com", cli.email)
        assertEquals("Max", cli.plan)
        assertNull(cli.operation)
    }

    @Test fun `reads a sign-in waiting for its code`() {
        val operation = ProviderCli.parse(json(cli("01b", signIn = "signed_out", operation = WAITING)))!!.operation!!
        assertEquals(ProviderCli.Operation.Status.Waiting, operation.status)
        assertTrue(operation.busy)
        assertTrue(operation.acceptsCode)
        assertEquals("https://claude.com/cai/oauth/authorize", operation.url)
        assertEquals("Waiting for you to finish signing in to Claude in your browser.", operation.message)
    }

    @Test fun `follows one program, newer events only, and a server without them is unsupported`() = runTest {
        val events = MutableSharedFlow<AgentEvent>(extraBufferCapacity = 8)
        var reads = 0
        val source = ProviderCliSource({ id ->
            reads++
            if (id == "grok") throw AgentApiException(501, "unsupported", "Not in team mode.")
            ProviderCli.parse(json(cli("01b", signIn = "signed_out")))
        }, events, backgroundScope)
        val claude = source.follow("claude")
        assertEquals(ProviderCliSource.State.Reading, claude.value)
        runCurrent()
        assertEquals(ProviderCli.SignIn.SignedOut, (claude.value as ProviderCliSource.State.Read).cli.signIn)
        // An older copy doesn't replace a newer one.
        events.emit(AgentEvent("c1", "provider_cli.updated", json("""{"providerCli":${cli("01a", signIn = "signed_in")}}""")))
        runCurrent()
        assertEquals(ProviderCli.SignIn.SignedOut, (claude.value as ProviderCliSource.State.Read).cli.signIn)
        events.emit(AgentEvent("c2", "provider_cli.updated", json("""{"providerCli":${cli("01c", signIn = "signed_in")}}""")))
        runCurrent()
        assertEquals(ProviderCli.SignIn.SignedIn, (claude.value as ProviderCliSource.State.Read).cli.signIn)
        // The same program again is the same copy, not another read.
        source.follow("claude")
        assertEquals(1, reads)

        val grok = source.follow("grok")
        runCurrent()
        assertEquals(ProviderCliSource.State.Unsupported, grok.value)
        assertFalse(grok.value is ProviderCliSource.State.Read)
    }

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private companion object {
        const val WAITING = """{"id":"q7","kind":"sign_in","status":"waiting","message":"Waiting for you to finish signing in to Claude in your browser.",
            "authorization":{"method":"browser","url":"https://claude.com/cai/oauth/authorize","userCode":null,"openedByProgram":false,"acceptsCode":true,"expiresAt":1755400600000},
            "output":[],"error":null,"startedAt":1,"finishedAt":null}"""

        fun cli(version: String, signIn: String, operation: String = "null"): String = """{"id":"claude","name":"Claude Code","vendor":"Anthropic","website":"https://claude.com/product/claude-code","providerId":"claude",
            "installation":{"status":"installed","path":"/Users/ada/.local/bin/claude","version":"2.1.312","source":"standalone","desktopApp":null},
            "installer":{"command":"curl -fsSL https://claude.ai/install.sh | bash","sourceUrl":"https://claude.ai/install.sh","sourceHost":"claude.ai","vendorSite":"https://claude.com"},
            "commands":{"run":"claude","signIn":"claude auth login"},
            "signIn":{"status":"$signIn","account":${if (signIn == "signed_in") """{"email":"ada@example.com","plan":"Max"}""" else "null"},"methods":["browser"]},
            "operation":$operation,"version":"$version","updatedAt":1}"""
    }
}
