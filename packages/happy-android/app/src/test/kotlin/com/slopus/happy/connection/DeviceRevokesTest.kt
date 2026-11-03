package com.slopus.happy.connection

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/** An agent that answers the device's own DELETE as the test says, or can't be reached; anything else is a 404. */
private class RevokingAgent : Transport {
    @Volatile var reachable = true
    private val statuses = ArrayDeque<Int>()
    /** The token each DELETE carried, in order. */
    val revoked = mutableListOf<String>()

    fun answer(vararg values: Int) = synchronized(this) { statuses.clear(); statuses.addAll(values.toList()) }

    override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
        if (!reachable) throw IOException("unreachable")
        if (method != "DELETE" || path != DeviceRevokes.PATH) return TransportResponse(404)
        val status = synchronized(this) {
            revoked += credential
            statuses.removeFirstOrNull() ?: 200
        }
        return TransportResponse(status, body = "{}".toByteArray())
    }

    override suspend fun close() {}
}

/** A disconnected pairing's device is removed from its agent (DeviceRevokes, iOS's DeviceRevokeQueue). */
@RunWith(AndroidJUnit4::class)
class DeviceRevokesTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val agent = RevokingAgent()

    private val revokePrefs get() = context.getSharedPreferences(DeviceRevokes.PREFS, Context.MODE_PRIVATE)
    private val secretPrefs get() = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE)
    private val registryPrefs get() = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE)

    private fun revokes() = DeviceRevokes(
        store = ExpoSecureStore(revokePrefs, keys, keychainService = DeviceRevokes.KEYCHAIN_SERVICE),
        scope = scope,
        makeTransport = { agent },
        backoffMillis = { 5 },
    )

    private fun connections(revokes: DeviceRevokes) = AgentConnections(
        secrets = ExpoSecureStore(secretPrefs, keys, keychainService = AgentConnections.KEYCHAIN_SERVICE),
        registry = registryPrefs,
        makeTransport = { agent },
        revokes = revokes,
    )

    private fun credentials(token: String) = AgentConnectionCredentials("tc", 1, "d-$token", token)

    @Before
    fun setUp() {
        listOf(revokePrefs, secretPrefs, registryPrefs).forEach { it.edit().clear().commit() }
    }

    @After
    fun tearDown() = scope.cancel()

    /** Gone (200), already gone (401) and a daemon from before the route (403) end it; a 5xx or no answer is tried again. */
    @Test
    fun itIsSentUntilTheAgentAnswersForGood() = runBlocking {
        val revokes = revokes()
        agent.answer(503, 429, 200)
        revokes.enqueue("a", credentials("old"))
        withTimeout(5_000) { revokes.awaitIdle() }
        assertEquals(listOf("old", "old", "old"), agent.revoked)
        for (status in listOf(401, 403, 404)) {
            agent.answer(status)
            revokes.enqueue("s$status", credentials("t$status"))
            withTimeout(5_000) { revokes.awaitIdle() }
            assertTrue("$status left it waiting", revokes.waiting().isEmpty())
        }
        assertTrue(DeviceRevokes.final(204) && DeviceRevokes.final(401) && DeviceRevokes.final(403))
        assertFalse(DeviceRevokes.final(500) || DeviceRevokes.final(408) || DeviceRevokes.final(429))
    }

    /** Out of reach it is kept, encrypted, across a restart, and goes once the agent answers. */
    @Test
    fun anUnreachableAgentIsTriedAgainAfterARestart() = runBlocking {
        agent.reachable = false
        val first = revokes()
        first.enqueue("a", credentials("secret-token"))
        assertFalse(revokePrefs.all.values.joinToString().contains("secret-token"))

        agent.reachable = true
        val restarted = revokes()
        restarted.resume()
        withTimeout(5_000) { restarted.awaitIdle() }
        assertEquals("secret-token", agent.revoked.last())
        assertTrue(restarted.waiting().isEmpty())
    }

    /** A token a connection here holds now is never sent, and a team server's sign-in has no device. */
    @Test
    fun aTokenInUseOrASignInIsNeverSent() = runBlocking {
        val revokes = revokes()
        revokes.inUse = { it == "mine" }
        revokes.enqueue("a", credentials("mine"))
        withTimeout(5_000) { revokes.awaitIdle() }
        revokes.enqueue("server", AgentConnectionCredentials("team.example.com", 443, "", ""))
        assertEquals(emptyList<String>(), agent.revoked)
        assertTrue(revokes.waiting().isEmpty())
    }

    /** Disconnect removes this phone's device from the agent with the pairing's own token. */
    @Test
    fun disconnectRevokesTheDevice() = runBlocking {
        val revokes = revokes()
        val connections = connections(revokes)
        val account = connections.add(credentials("first"), "Mac")
        connections.remove(account.id)
        withTimeout(5_000) { revokes.awaitIdle() }
        assertEquals(listOf("first"), agent.revoked)
    }

    /**
     * Disconnected while the agent couldn't be reached, then paired again:
     * the old device goes with the old token as the agent is reached, and
     * the new pairing's token is never sent.
     */
    @Test
    fun pairingAgainRevokesTheOldDeviceOnly() = runBlocking {
        val revokes = revokes()
        val connections = connections(revokes)
        val old = connections.add(credentials("first"), "Mac")
        agent.reachable = false
        connections.remove(old.id)
        assertEquals("first", revokes.waiting()[old.id]?.credentials?.deviceToken)

        agent.reachable = true
        connections.add(credentials("second"), "Mac")
        withTimeout(5_000) { revokes.awaitIdle() }
        assertEquals(setOf("first"), agent.revoked.toSet())
        assertEquals(1, connections.accounts.value.size)
    }
}
