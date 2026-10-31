package com.slopus.happy.journeys

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.data.DiskThread
import com.slopus.happy.data.MainThreadDiskException
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.node
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Offline first: everything shown comes from the phone's disk, read off
 * the main thread, and the server is asked only for what changed.
 *
 * - A cold start with the server gone shows the kept home and the kept
 *   chat (after their disk reads), with no request answered.
 * - Switching accounts and back shows each account's kept home, and the
 *   way back asks only for sessions changed since its watermark.
 * - A reconnect lists only changed sessions, and an open chat asks only for
 *   messages after the ones it has.
 *
 * Throughout, any read or write of the account store on the main thread
 * fails the test ([DiskThread.strict]).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OfflineFirstJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val server = FakeHappyServer().start()
    private val second = FakeHappyServer(ByteArray(32) { (it * 11 + 3).toByte() }).start()
    private val graphs = mutableListOf<AppGraph>()

    /** The Android keystore outlives the process; so does this. */
    private val keys = SoftwareKeys()

    @Before
    fun setUp() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, ServerConfig.PREFS_NAME)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }

    @After
    fun tearDown() {
        DiskThread.strict = false
        graphs.forEach { runBlocking { it.account.value?.stop() } }
        server.close()
        second.close()
    }

    /** A graph over files, as the app's: a second one over the same files is the process started again. */
    private fun graph(): AppGraph = AppGraph(
        context = context,
        clientId = "android/test",
        defaultServerUrl = server.url,
        secureStoreKeys = keys,
        databaseName = "offline-first.db",
    ).also {
        graphs += it
        it.setForeground(true)
    }

    private fun backup(of: FakeHappyServer) = SecretKeyBackup.format(encodeBase64(of.secret, Base64Variant.Url))

    private fun chat(on: FakeHappyServer, id: String, title: String, messages: Int) {
        on.addMachine("m1", Journey.machineMetadata())
        on.addSession(id, updatedAt = 100, metadata = Journey.sessionMetadata("/h/$id", title))
        repeat(messages) { n ->
            on.appendMessage(id, buildJsonObject {
                put("role", "user")
                put("content", buildJsonObject { put("type", "text"); put("text", "$title $n") })
            })
        }
    }

    @Test
    fun aColdStartWithTheServerGoneShowsTheKeptHomeAndChat() {
        chat(server, "s1", "Kept chat", messages = 20)
        var current by mutableStateOf(graph())
        runBlocking { current.auth.restore(backup(server)) }
        DiskThread.strict = true
        // The guard is on: this thread is the main thread, where a store read throws.
        assertThrows(MainThreadDiskException::class.java) { current.store.sessions() }
        rule.setContent { key(current) { HappyApp(current) } }

        // Online once: home, then the chat, which keeps its newest page.
        rule.waitForText("Kept chat")
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitForText("Kept chat 19")

        // The process goes, and so does the network.
        runBlocking { current.account.value?.stop() }
        server.close()
        val next = graph()
        assertTrue(next.auth.state.value is AuthState.SignedIn)
        current = next

        // The kept home, then the kept chat, from disk alone.
        rule.waitForText("Kept chat")
        rule.waitUntil(10_000) { next.connectionStatus.value != ConnectionStatus.CONNECTED }
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        rule.waitForText("Kept chat 19")
        rule.waitFor(MessageTags.USER)
    }

    @Test
    fun switchingAccountsAndBackShowsEachKeptHomeAndAsksOnlyForWhatChanged() {
        chat(server, "a1", "First account chat", messages = 3)
        chat(second, "b1", "Second account chat", messages = 3)
        val graph = graph()
        runBlocking { graph.auth.restore(backup(server)) }
        graph.serverConfig.set(second.url)
        graph.accountStore.select("agent-connection-1")
        runBlocking { graph.auth.reload() }
        runBlocking { graph.auth.restore(backup(second)) }
        val (a, b) = graph.accountStore.registry.value.ordered.map { it.id }

        DiskThread.strict = true
        rule.setContent { HappyApp(graph) }
        rule.waitForText("Second account chat")

        runBlocking { graph.open(a).join() }
        rule.waitForText("First account chat")
        rule.waitUntil(10_000) { server.requestsTo("/v2/sessions").isNotEmpty() }
        val before = server.requestsTo("/v2/sessions").size

        // And back: the second account's kept home, then only what changed since its watermark.
        runBlocking { graph.open(b).join() }
        rule.waitForText("Second account chat")
        runBlocking { graph.open(a).join() }
        rule.waitForText("First account chat")
        rule.waitUntil(10_000) { server.requestsTo("/v2/sessions").size > before }
        val since = server.requestsTo("/v2/sessions").drop(before)
        assertTrue(since.joinToString { it.url.toString() }, since.all { it.url.queryParameter("changedSince") != null })
    }

    @Test
    fun aReconnectListsOnlyChangedSessionsAndAnOpenChatAsksOnlyForNewerMessages() {
        chat(server, "s1", "Busy chat", messages = 12)
        val graph = graph()
        runBlocking { graph.auth.restore(backup(server)) }
        DiskThread.strict = true
        rule.setContent { HappyApp(graph) }
        rule.waitForText("Busy chat")
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitForText("Busy chat 11")
        rule.waitUntil(10_000) { graph.connectionStatus.value == ConnectionStatus.CONNECTED }
        rule.waitUntil(10_000) { graph.isSyncing.value.not() }
        val listed = server.requests.size

        // The link drops and comes back.
        server.dropSockets()
        rule.waitUntil(10_000) { server.socketAuths.size >= 2 && graph.connectionStatus.value == ConnectionStatus.CONNECTED }
        rule.waitUntil(10_000) { server.requests.drop(listed).any { it.url.encodedPath == "/v2/sessions" } }
        rule.waitUntil(10_000) { server.requests.drop(listed).any { it.url.encodedPath == "/v3/sessions/s1/messages" } }
        rule.waitUntil(10_000) { graph.isSyncing.value.not() }

        val after = server.requests.drop(listed)
        val sessions = after.filter { it.url.encodedPath == "/v2/sessions" }
        assertTrue(sessions.joinToString { it.url.toString() }, sessions.all { it.url.queryParameter("changedSince") != null })
        val history = after.filter { it.url.encodedPath == "/v3/sessions/s1/messages" && it.method == "GET" }
        assertTrue(history.joinToString { it.url.toString() }, history.isNotEmpty() && history.all { it.url.queryParameter("after_seq") == "12" })
        // Nothing older is fetched again.
        assertEquals(0, history.count { it.url.queryParameter("before_seq") != null })
    }
}
