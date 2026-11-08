package com.slopus.happy.fixture

import android.content.Context
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AccessToken
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.AgentOrigin
import com.slopus.happy.connection.ByteSource
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.OAuthCredential
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportStream
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.linkState
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException

/**
 * A Happy Cloud server's link in its headers on a device: the real
 * [AgentSession] of a server connection, over a server that exists only in
 * this test's memory, feeding the real link pipeline ([linkState],
 * [rememberShownLinkState]) into the real home and chat screens. Its home
 * comes slowly first ("Updating…"), then it goes away while the phone has
 * its network ("Connecting…", never offline), then it comes back. Captured
 * to the app's files under `device-evidence/cloud-link/`.
 *
 * Not covered: AppGraph and the app's own routes, which this mirrors
 * (`SignedInAgentHome`, `ConversationEntry`); a real Happy Cloud server.
 */
@RunWith(AndroidJUnit4::class)
class CloudLinkDeviceShots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence/cloud-link").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun tearDown() = scope.cancel()

    /** The server: away, it answers nothing and its stream drops; [held], its home waits. */
    private class FlakyServer : Transport {
        @Volatile var online = true
        @Volatile var held: CompletableDeferred<Unit>? = null
        var frames = Channel<String>(Channel.UNLIMITED)
        val calls = java.util.concurrent.CopyOnWriteArrayList<String>()

        fun goAway() {
            online = false
            frames.close()
            frames = Channel(Channel.UNLIMITED)
        }

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            calls += path
            if (!online) throw IOException("no answer")
            fun ok(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
            return when (path) {
                "/v0/health" -> ok("""{"ready":true,"version":{"protocol":30,"daemon":"1.0"}}""")
                "/v0/config" -> ok("""{"config":{"node":{"name":"Acme","avatar":null}}}""")
                "/v0/bootstrap/desktop" -> {
                    held?.await()
                    if (!online) throw IOException("no answer")
                    ok(HOME)
                }
                else -> TransportResponse(404, body = """{"error":"Not found.","code":"not_found"}""".toByteArray())
            }
        }

        override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
            if (!online) throw IOException("no answer")
            val channel = frames
            channel.trySend(HELLO)
            var headSent = false
            return TransportStream.open(object : ByteSource {
                override suspend fun read(): ByteArray {
                    if (!headSent) {
                        headSent = true
                        return "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n".toByteArray()
                    }
                    val bytes = (channel.receiveCatching().getOrNull() ?: return ByteArray(0)).toByteArray()
                    return "${bytes.size.toString(16)}\r\n".toByteArray() + bytes + "\r\n".toByteArray()
                }

                override fun close() {}
            })
        }

        override suspend fun close() {}
    }

    private var describe: () -> String = { "" }

    private fun eventually(what: String, seconds: Long = 15, check: () -> Boolean) {
        val until = SystemClock.uptimeMillis() + seconds * 1000
        while (!check()) {
            if (SystemClock.uptimeMillis() > until) {
                device.takeScreenshot(File(evidence, "failed.png"))
                throw AssertionError("never: $what (${describe()})")
            }
            pass(50)
        }
    }

    /** [millis] of wall time, the compose rule's clock kept with it: its frames and effects run as they would. */
    private fun pass(millis: Long) {
        rule.mainClock.advanceTimeBy(millis)
        SystemClock.sleep(millis)
    }

    private fun shot(name: String) {
        repeat(12) { pass(50) }
        device.takeScreenshot(File(evidence, "$name.png"))
    }

    @Test fun cloudServerSaysUpdatingThenConnectingNeverOffline() = runBlocking {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val prefs = { name: String -> app.getSharedPreferences("cloud-link-shots-$name", Context.MODE_PRIVATE).also { it.edit().clear().commit() } }
        val connections = AgentConnections(ExpoSecureStore(prefs("secrets"), AndroidKeyStoreKeys(strongBox = false), keychainService = "cloud-link-shots"), prefs("registry"))
        val server = FlakyServer()
        val origin = AgentOrigin.parse("https://acme.${HappyCloud.base ?: "happy-clusters.com"}")
        val credential = OAuthCredential("jwt", "happy", "${origin.value}/refresh", "refresh", origin.value, userId = "u1")
        val id = connections.addServer(origin, credential, AccessToken("access", null), fallbackName = "Acme").id
        server.held = CompletableDeferred()
        val shown = mutableStateOf(LinkState.Online)
        val session = AgentSession(id, connections, null, MutableStateFlow(true), scope, { server })
        describe = { "status ${session.status.value}, syncing ${session.isSyncing.value}, shown ${shown.value}, calls ${server.calls}" }
        val fixture = FixtureTransport()
        val conversation = Conversation(api = ConversationApi(fixture.request), signals = emptyFlow(), scope = scope, agentId = FixtureTransport.AGENT)
        val chat = mutableStateOf(false)
        val accounts = AccountMenu(listOf(AccountMenuEntry(id, "Acme", agent = true, active = true)))
        rule.setContent {
            HappyTheme {
                val status by session.status.collectAsState()
                val syncing by session.isSyncing.collectAsState()
                val feed by session.feed.collectAsState()
                // As SignedInAgentHome and ConversationEntry work it out.
                val link = rememberShownLinkState(status.linkState(syncing, network = true))
                shown.value = link
                if (chat.value) {
                    val state by conversation.state.collectAsState()
                    ConversationScreen(
                        state = state,
                        connection = if (link == LinkState.Offline) "offline" else null,
                        actions = remember {
                            ConversationScreenActions(
                                onBack = {}, onDraftChange = conversation::setDraft, onSend = { _, _ -> false }, onAnswer = conversation::answer,
                                onOpenArtifact = {}, onRetryLoad = conversation::retryLoad, loadMedia = conversation::media, onVisible = conversation::setVisible,
                            )
                        },
                        link = link,
                    )
                } else {
                    AgentHomeScreen("Acme", feed, status, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}), link = link)
                }
            }
        }

        // Its home read slowly: the server answered, so this is catching up.
        eventually("updating…") { shown.value == LinkState.Syncing }
        shot("1-cloud-home-updating")
        chat.value = true
        shot("2-cloud-chat-updating")
        chat.value = false
        server.held?.complete(Unit)
        eventually("live") { session.status.value == AgentLinkStatus.Connected && shown.value == LinkState.Online && session.feed.value.loaded }
        shot("3-cloud-home-online")

        // Away while the phone has its network: on its way back, asked again and again.
        server.goAway()
        eventually("connecting…") { shown.value == LinkState.Connecting }
        repeat(80) { pass(50) }
        assertEquals(AgentLinkStatus.Connecting, session.status.value)
        assertEquals(LinkState.Connecting, shown.value)
        shot("4-cloud-home-connecting")
        chat.value = true
        shot("5-cloud-chat-connecting")
        chat.value = false

        server.online = true
        session.networkReturned()
        eventually("live again", 20) { session.status.value == AgentLinkStatus.Connected && shown.value == LinkState.Online }
        shot("6-cloud-home-back")
        assertTrue(File(evidence, "4-cloud-home-connecting.png").exists())
        session.close()
    }

    private companion object {
        const val HELLO = "event: hello\ndata: {\"cursor\":\"c1\",\"gap\":false,\"resumed\":true,\"daemonId\":\"d1\"}\n\n"
        val HOME = """
            {"projects":[],"workspaces":[],"bots":[],"cursor":"c1","profile":{"userId":"u1"},
             "tasks":[
               {"id":"ship","name":"Ship the cache","version":"01","status":"active","archivedAt":null,"agent":{"id":"ship-agent","workspaceId":"w1","version":"01","status":"idle","parentAgentId":null,"subtask":false,"userVisible":true,"title":null,"titleStatus":"idle","pendingQuestionId":null,"unread":null,"subtasks":[],"orderKey":null,"archivedAt":null,"createdAt":1,"updatedAt":2}},
               {"id":"old","name":"Old notes","version":"01","status":"active","archivedAt":null,"agent":{"id":"old-agent","workspaceId":"w2","version":"01","status":"idle","parentAgentId":null,"subtask":false,"userVisible":true,"title":null,"titleStatus":"idle","pendingQuestionId":null,"unread":null,"subtasks":[],"orderKey":null,"archivedAt":null,"createdAt":1,"updatedAt":3}}],
             "taskMemberships":[{"taskId":"ship","orderKey":"1"},{"taskId":"old","orderKey":"2"}]}
        """.trimIndent()
    }
}
