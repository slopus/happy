package com.slopus.happy.connection

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.crypto.CanonicalBase64Url
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/** Paired agents kept on the phone, and one pairing from code to kept agent. */
@RunWith(AndroidJUnit4::class)
class AgentConnectionsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val daemon = FakeDaemon().apply { deviceToken = ByteArray(32) { 7 } }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var transport: (AgentConnectionCredentials) -> Transport = { daemon }

    private val secretPrefs get() = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE)
    private val registryPrefs get() = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE)

    private val pictures get() = java.io.File(context.filesDir, "agent-avatars")

    private fun accounts() = AgentConnections(
        secrets = ExpoSecureStore(secretPrefs, keys, keychainService = AgentConnections.KEYCHAIN_SERVICE),
        registry = registryPrefs,
        makeTransport = { transport(it) },
        now = { PAIRING_NOW },
        pictures = pictures,
    )

    private fun credentials(deviceId: String = "dv1") =
        AgentConnectionCredentials("tcFixedVectorAddress", 24781, deviceId, CanonicalBase64Url.encode(daemon.deviceToken))

    @Before
    fun setUp() {
        secretPrefs.edit().clear().commit()
        registryPrefs.edit().clear().commit()
        pictures.deleteRecursively()
    }

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun anAgentIsKeptUnderItsOwnNameWithItsSecretsEncrypted() = runBlocking {
        val account = accounts().add(credentials(), "Steve's Mac")
        assertEquals("Studio", account.name)
        assertEquals("abc", account.thumbhash)
        assertTrue(account.id.startsWith("agent-connection-"))
        assertEquals(1, daemon.closed)

        // A new start reads the same list and credentials back.
        val reread = accounts()
        assertEquals(listOf(account), reread.accounts.value)
        assertEquals(credentials(), reread.credentials(account.id))

        // Neither store holds the token or the address in the clear.
        val stored = (secretPrefs.all.values + registryPrefs.all.values).joinToString()
        assertFalse(stored.contains(credentials().deviceToken))
        assertFalse(stored.contains("tcFixedVectorAddress"))
    }

    @Test
    fun authenticatedEndpointSelectionPersistsWithoutReplacingAccountOrToken() = runBlocking {
        val accounts = accounts()
        val original = credentials()
        val account = accounts.add(original, "Mac")
        val client = accounts.transport(account.id, original) { daemon }
        daemon.endpointAdvertisement = kotlinx.serialization.json.JsonPrimitive("https://agent.example:8443")
        client.request("GET", "/v0/config", original.deviceToken)
        assertEquals(original.copy(publicUrl = "https://agent.example:8443"), accounts.credentials(account.id))
        assertEquals(accounts.credentials(account.id), accounts().credentials(account.id))
        assertEquals(account.id, accounts.accounts.value.single().id)
        daemon.endpointAdvertisement = kotlinx.serialization.json.JsonNull
        client.request("GET", "/v0/config", original.deviceToken)
        assertEquals(original, accounts().credentials(account.id))
        client.close()
    }

    @Test
    fun repeatedCompletedPairingKeepsDiscoveredRouteAndExistingClientEvenAfterRejection() = runBlocking {
        val accounts = accounts()
        val original = credentials()
        val account = accounts.add(original, "Mac")
        val client = accounts.transport(account.id, original) { daemon }
        daemon.endpointAdvertisement = kotlinx.serialization.json.JsonPrimitive("https://agent.example")
        client.request("GET", "/v0/config", original.deviceToken)
        assertEquals(account.id, accounts.add(original, "Mac").id)
        assertEquals("https://agent.example", accounts.credentials(account.id)!!.publicUrl)
        assertEquals(200, client.request("GET", "/v0/health", original.deviceToken).status)
        val accepting = transport
        transport = { object : Transport by daemon {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) = TransportResponse(401)
        } }
        try { accounts.add(original, "Mac"); fail("revoked pairing accepted") }
        catch (error: AgentConnectionException) { assertEquals(AgentConnectionException.Reason.Revoked, error.reason) }
        transport = accepting
        assertEquals(200, client.request("GET", "/v0/health", original.deviceToken).status)
        client.close()
    }

    @Test
    fun failedPairingPersistenceDoesNotRetireExistingClients() = runBlocking {
        var denyWrites = false
        val preferences = object : android.content.SharedPreferences by secretPrefs {
            override fun edit(): android.content.SharedPreferences.Editor {
                val base = secretPrefs.edit()
                return object : android.content.SharedPreferences.Editor by base {
                    override fun putString(key: String?, value: String?): android.content.SharedPreferences.Editor {
                        base.putString(key, value)
                        return this
                    }
                    override fun commit(): Boolean = if (denyWrites) false else base.commit()
                }
            }
        }
        val accounts = AgentConnections(ExpoSecureStore(preferences, keys, keychainService = AgentConnections.KEYCHAIN_SERVICE), registryPrefs, makeTransport = { daemon })
        val original = credentials()
        val account = accounts.add(original, "Mac")
        val client = accounts.transport(account.id, original) { daemon }
        assertEquals(200, client.request("GET", "/v0/health", original.deviceToken).status)
        denyWrites = true
        try { accounts.add(original, "Mac"); fail("failed save accepted") }
        catch (_: java.security.GeneralSecurityException) { }
        assertEquals(200, client.request("GET", "/v0/health", original.deviceToken).status)
        assertEquals(original, accounts.credentials(account.id))
        client.close()
    }

    @Test
    fun theAgentsOwnPictureIsKeptAsAFileAndAskedForOnlyWhenChanged() = runBlocking {
        daemon.avatar = byteArrayOf(1, 2, 3)
        val accounts = accounts()
        val account = accounts.add(credentials(), "Steve's Mac")
        val first = java.io.File(account.avatarFile!!)
        assertTrue(first.readBytes().contentEquals(byteArrayOf(1, 2, 3)))
        assertEquals("\"3\"", account.avatarETag)
        val token = credentials().deviceToken

        // Unchanged: a 304, and the same file.
        val same = AgentIdentity.refresh(daemon, token, "", account.avatarETag)
        assertEquals(NodeAvatar.Unchanged, same.avatar)
        accounts.update(account.id, same.avatar) { it }
        assertEquals(first.path, accounts.accounts.value.single().avatarFile)

        // A new picture: a new file, the old one gone.
        daemon.avatar = byteArrayOf(4, 5, 6, 7)
        accounts.update(account.id, AgentIdentity.refresh(daemon, token, "", account.avatarETag).avatar) { it }
        val second = java.io.File(accounts.accounts.value.single().avatarFile!!)
        assertTrue(second.readBytes().contentEquals(byteArrayOf(4, 5, 6, 7)))
        assertFalse(first.exists())

        // Taken away on the agent: none kept.
        daemon.avatar = null
        accounts.update(account.id, AgentIdentity.refresh(daemon, token, "", "\"4\"").avatar) { it }
        assertNull(accounts.accounts.value.single().avatarFile)
        assertFalse(second.exists())

        // Removing the agent removes its picture.
        daemon.avatar = byteArrayOf(9)
        accounts.update(account.id, AgentIdentity.refresh(daemon, token, "").avatar) { it }
        val third = java.io.File(accounts.accounts.value.single().avatarFile!!)
        accounts.remove(account.id)
        assertFalse(third.exists())
    }

    @Test
    fun aPictureThatIsntOneLeavesTheAgentReachable() = runBlocking {
        transport = { object : Transport by daemon {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) =
                if (path == "/v0/node/avatar") TransportResponse(200, mapOf("content-type" to "text/html"), "<html>".toByteArray())
                else daemon.request(method, path, credential, body, headers)
        } }
        val account = accounts().add(credentials(), "Steve's Mac")
        assertEquals("Studio", account.name)
        assertNull(account.avatarFile)
    }

    @Test
    fun pairingTheSameDeviceAgainUpdatesItsEntry() = runBlocking {
        val accounts = accounts()
        val first = accounts.add(credentials(), "Steve's Mac")
        daemon.agentName = "Renamed"
        val again = accounts.add(credentials(), "Steve's Mac")
        assertEquals(first.id, again.id)
        assertEquals(listOf("Renamed"), accounts.accounts.value.map { it.name })
        accounts.add(credentials(deviceId = "dv2"), "Steve's Mac")
        assertEquals(2, accounts.accounts.value.size)
    }

    @Test
    fun theInstanceIdExternalLinksAreLockedToIsKeptFromHealth() = runBlocking {
        val accounts = accounts()
        assertEquals(null, accounts.add(credentials(), "Steve's Mac").instanceId)
        daemon.instanceId = "k3x9q2m7p0a4b8c1d5e6f7g2"
        assertEquals("k3x9q2m7p0a4b8c1d5e6f7g2", accounts.add(credentials(), "Steve's Mac").instanceId)
        assertEquals("k3x9q2m7p0a4b8c1d5e6f7g2", accounts().accounts.value.single().instanceId)
        // Anything but a well-formed id counts as none; the one known stays.
        daemon.instanceId = "Not-An-Instance"
        assertEquals("k3x9q2m7p0a4b8c1d5e6f7g2", accounts.add(credentials(), "Steve's Mac").instanceId)
    }

    @Test
    fun anUnreachableAgentIsKeptUnderTheCodesName() = runBlocking {
        transport = { object : Transport by daemon {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) =
                throw IOException("offline")
        } }
        assertEquals("Steve's Mac", accounts().add(credentials(), "Steve's Mac").name)
    }

    @Test
    fun anAgentThatRefusesTheTokenIsNotKept() = runBlocking {
        daemon.revoked = true
        val accounts = accounts()
        try {
            accounts.add(credentials(), "Steve's Mac"); fail()
        } catch (e: AgentConnectionException) {
            assertEquals(AgentConnectionException.Reason.Revoked, e.reason)
        }
        assertTrue(accounts.accounts.value.isEmpty())
        assertTrue(secretPrefs.all.isEmpty())
    }

    @Test
    fun removingForgetsTheCredentials() = runBlocking {
        val accounts = accounts()
        val account = accounts.add(credentials(), "Steve's Mac")
        accounts.update(account.id) { it.copy(revoked = true) }
        assertTrue(accounts.accounts.value.single().revoked)
        accounts.remove(account.id)
        assertTrue(accounts.accounts.value.isEmpty())
        assertNull(accounts.credentials(account.id))
        assertTrue(accounts().accounts.value.isEmpty())
    }

    private fun flow(daemon: FakeDaemon, accounts: AgentConnections = accounts()) =
        PairingFlow(scope, accounts, "Pixel 9", makeTransport = { daemon }, now = { PAIRING_NOW })

    private suspend inline fun <reified S : PairingState> PairingFlow.await(): S =
        withTimeout(10_000) { state.first { it is S } as S }

    @Test
    fun aMatchedPairingKeepsTheAgent() = runBlocking {
        val pairing = FakeDaemon()
        transport = { pairing }
        val accounts = accounts()
        val flow = flow(pairing, accounts)
        flow.start(pairingCode())
        assertEquals("Steve's Mac", flow.state.value?.agentName)
        assertEquals(4, flow.await<PairingState.Compare>().emoji.size)
        flow.confirm()
        val paired = flow.await<PairingState.Paired>()
        assertEquals("Studio", paired.account.name)
        assertEquals(listOf(paired.account), accounts.accounts.value)
        assertEquals(CanonicalBase64Url.encode(pairing.deviceToken), accounts.credentials(paired.account.id)?.deviceToken)
        // Leaving the finished pairing rejects nothing.
        flow.close()
        assertFalse(pairing.rejected)
    }

    @Test
    fun mismatchedEmojiRejectAndKeepNothing() = runBlocking {
        val pairing = FakeDaemon()
        val flow = flow(pairing)
        flow.start(pairingCode())
        flow.await<PairingState.Compare>()
        flow.reject()
        assertEquals(AgentConnectionException.Reason.Rejected.message, flow.await<PairingState.Failed>().message)
        withTimeout(10_000) { while (!pairing.rejected) kotlinx.coroutines.delay(10) }
        assertTrue(accounts().accounts.value.isEmpty())
    }

    @Test
    fun leavingAnUnfinishedPairingRejectsIt() = runBlocking {
        val pairing = FakeDaemon()
        val flow = flow(pairing)
        flow.start(pairingCode())
        flow.await<PairingState.Compare>()
        flow.close()
        withTimeout(10_000) { while (!pairing.rejected) kotlinx.coroutines.delay(10) }
        assertTrue(accounts().accounts.value.isEmpty())
    }

    @Test
    fun aBadCodeFailsWithoutConnecting() {
        val pairing = FakeDaemon()
        val flow = flow(pairing)
        flow.start(pairingCode(e = PAIRING_NOW - 1))
        val failed = flow.state.value as PairingState.Failed
        assertEquals(AgentConnectionException.Reason.Expired.message, failed.message)
        assertTrue(pairing.calls.isEmpty())
    }
}
