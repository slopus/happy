package com.slopus.happy.accounts

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Several Happy accounts on one phone, as on iOS: each on its own server
 * with its own credentials and database, the React Native app's account
 * first, switching keeping every account signed in.
 */
@RunWith(AndroidJUnit4::class)
class MultipleAccountsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val first = FakeHappyServer().start()
    private val second = FakeHappyServer(ByteArray(32) { (it * 11 + 3).toByte() }).start()
    private val graphs = mutableListOf<AppGraph>()

    @Before
    fun setUp() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, ServerConfig.PREFS_NAME)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
        File(context.filesDir, "mmkv").deleteRecursively()
        first.addSession("a1", updatedAt = 100)
        second.addSession("b1", updatedAt = 100)
        second.addSession("b2", updatedAt = 200)
    }

    @After
    fun tearDown() {
        graphs.forEach { runBlocking { it.account.value?.stop() } }
        first.close()
        second.close()
    }

    private fun graph(defaultServer: String = "https://default.invalid") =
        AppGraph(context, "android/test", defaultServer, keys, databaseName = null).also { graphs += it; it.setForeground(true) }

    private fun backup(server: FakeHappyServer) = SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))

    private fun openId(graph: AppGraph) = (graph.auth.state.value as? AuthState.SignedIn)?.let { accountId(it.credentials) }

    private fun sessionIds(graph: AppGraph) = graph.store.sessions().map { it.id }.toSet()

    private fun syncedTo(graph: AppGraph, ids: Set<String>) {
        eventually(message = "sessions $ids") {
            graph.account.value?.let { runBlocking { it.syncNow() } }
            sessionIds(graph) == ids
        }
    }

    @Test
    fun theReactNativeAccountAndServerOpenFirst() {
        SecureStoreCredentialStore(ExpoSecureStore(context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE), keys))
            .write(AuthCredentials(first.token, encodeBase64(first.secret, Base64Variant.Url)))
        MmkvFixtures.write(MmkvFixtures.file(MmkvFixtures.region(listOf("custom-server-url" to first.url + "/"))), File(context.filesDir, "mmkv"))

        val graph = graph()
        val entry = graph.accountStore.registry.value.entries.single()
        assertEquals(CredentialLocation.Shared, entry.location)
        assertEquals(first.url, entry.serverUrl)
        assertTrue(graph.auth.state.value is AuthState.SignedIn)
        syncedTo(graph, setOf("a1"))
    }

    @Test
    fun anUnreadableServerSettingKeepsTheTokenOffTheNetwork() {
        SecureStoreCredentialStore(ExpoSecureStore(context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE), keys))
            .write(AuthCredentials(first.token, encodeBase64(first.secret, Base64Variant.Url)))
        MmkvFixtures.write("torn".toByteArray() to ByteArray(0), File(context.filesDir, "mmkv"))

        val graph = graph(defaultServer = first.url)
        assertFalse(graph.accountStore.registry.value.entries.single().serverConfirmed)
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        Thread.sleep(300)
        assertTrue(first.requests.isEmpty())
    }

    @Test
    fun addingSwitchingAndSigningOutKeepEachAccountApart() {
        val graph = graph(defaultServer = first.url)
        runBlocking { graph.auth.restore(backup(first)) }
        syncedTo(graph, setOf("a1"))

        // Add, from an open agent connection: a new account on the chosen server; the first stays signed in.
        graph.accountStore.select("agent-connection-1")
        runBlocking { graph.auth.reload() }
        graph.serverConfig.set(second.url)
        runBlocking { graph.auth.restore(backup(second)) }
        syncedTo(graph, setOf("b1", "b2"))
        val registry = graph.accountStore.registry.value
        assertEquals(listOf(first.url, second.url), registry.ordered.map { it.serverUrl })
        assertEquals(listOf(CredentialLocation.Shared, CredentialLocation.Own), registry.ordered.map { it.location })
        val (a, b) = registry.ordered.map { it.id }
        assertEquals(b, registry.activeId)

        runBlocking { graph.open(a).join() }
        eventually(message = "switched") { openId(graph) == a }
        syncedTo(graph, setOf("a1"))

        // A new start opens the account chosen last.
        val again = graph(defaultServer = first.url)
        assertEquals(a, again.accountStore.registry.value.activeId)
        assertEquals(2, again.accountStore.registry.value.entries.size)

        // Signing out of the open account opens the next; its data is still there.
        runBlocking { graph.logout().join() }
        eventually(message = "next account") { openId(graph) == b }
        syncedTo(graph, setOf("b1", "b2"))
        assertEquals(listOf(b), graph.accountStore.registry.value.entries.map { it.id })
        assertNull(SecureStoreCredentialStore(ExpoSecureStore(context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE), keys)).read())

        runBlocking { graph.logout().join() }
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertTrue(graph.accountStore.registry.value.entries.isEmpty())
        assertTrue(sessionIds(graph).isEmpty())
    }

    @Test
    fun anOpenAgentConnectionKeepsTheHappyAccountSignedIn() {
        val graph = graph(defaultServer = first.url)
        runBlocking { graph.auth.restore(backup(first)) }
        val account = graph.accountStore.registry.value.activeId!!
        // An agent connection opens: no Happy account is open, none is signed out.
        graph.accountStore.select("agent-connection-1")
        runBlocking { graph.auth.reload() }
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertEquals("agent-connection-1", graph(defaultServer = first.url).accountStore.registry.value.activeId)
        assertEquals(listOf(account), graph.accountStore.registry.value.entries.map { it.id })
        runBlocking { graph.open(account).join() }
        eventually(message = "account again") { openId(graph) == account }
    }
}
