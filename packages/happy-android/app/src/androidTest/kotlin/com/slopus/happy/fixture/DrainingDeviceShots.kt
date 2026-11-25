package com.slopus.happy.fixture

import android.content.Context
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.ByteSource
import com.slopus.happy.connection.LinkState
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.connection.TransportStream
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.chat.rememberShownLinkState
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.ConnectionDiagnosticsScreen
import com.slopus.happy.ui.connection.ConnectionPageState
import com.slopus.happy.ui.connection.statusText
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.linkState
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
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

/**
 * A paired computer whose daemon drains to restart, on a device: the real
 * [AgentSession] over a computer that exists only in this test's memory,
 * feeding the real link pipeline ([linkState], [rememberShownLinkState])
 * into the real home and chat screens, and the connection page as
 * `ConnectionDiagnostics` fills it. The computer says `daemon.draining` and
 * refuses a send 503: home, the chat and the page say "Agent restarting…",
 * the page its last error; a new process's hello brings home back online.
 * Captured to the app's files under `device-evidence/draining/`.
 */
@RunWith(AndroidJUnit4::class)
class DrainingDeviceShots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence/draining").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun tearDown() = scope.cancel()

    /** The computer: [hello] is what its next stream says first; a send is refused while [draining]. */
    private class Computer : Transport {
        @Volatile var hello = hello("d1", draining = false)
        @Volatile var draining = false
        var frames = Channel<String>(Channel.UNLIMITED)

        /** The old process goes: its stream ends, and the next is the new one's. */
        fun restart(daemonId: String) {
            draining = false
            hello = hello(daemonId, draining = false)
            frames.close()
            frames = Channel(Channel.UNLIMITED)
        }

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            fun ok(text: String) = TransportResponse(200, mapOf("content-type" to "application/json"), text.toByteArray())
            return when {
                path == "/v0/health" -> ok("""{"ready":true,"version":{"protocol":30,"daemon":"1.0"}}""")
                path == "/v0/config" -> ok("""{"config":{"node":{"name":"Studio","avatar":null}}}""")
                path == "/v0/bootstrap/desktop" -> ok(HOME)
                path.endsWith("/send") && draining -> TransportResponse(503, body = """{"error":"Happy Agent is draining and no longer accepts mutations.","code":"draining"}""".toByteArray())
                else -> TransportResponse(404, body = """{"error":"Not found.","code":"not_found"}""".toByteArray())
            }
        }

        override suspend fun stream(path: String, credential: String, headers: Map<String, String>, silenceMillis: Long): TransportStream {
            val channel = frames
            channel.trySend(hello)
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

    /** [millis] of wall time, the compose rule's clock kept with it. */
    private fun pass(millis: Long) {
        rule.mainClock.advanceTimeBy(millis)
        SystemClock.sleep(millis)
    }

    private fun shot(name: String) {
        repeat(12) { pass(50) }
        device.takeScreenshot(File(evidence, "$name.png"))
    }

    private fun connections(): AgentConnections {
        val prefs = { name: String -> app.getSharedPreferences("draining-shots-$name", Context.MODE_PRIVATE).also { it.edit().clear().commit() } }
        return AgentConnections(ExpoSecureStore(prefs("secrets"), AndroidKeyStoreKeys(strongBox = false), keychainService = "draining-shots"), prefs("registry"))
    }

    private enum class Screen { Home, Chat, Connection }

    /** Home, the chat or the connection page, as `SignedInAgentHome`, `ConversationEntry` and `ConnectionDiagnostics` show [session]. */
    private fun screens(session: AgentSession, id: String, screen: androidx.compose.runtime.MutableState<Screen>, shown: androidx.compose.runtime.MutableState<LinkState>) {
        val fixture = FixtureTransport()
        val conversation = Conversation(api = ConversationApi(fixture.request), signals = emptyFlow(), scope = scope, agentId = FixtureTransport.AGENT)
        val accounts = AccountMenu(listOf(AccountMenuEntry(id, "Studio", agent = true, active = true)))
        rule.setContent {
            HappyTheme {
                val status by session.status.collectAsState()
                val syncing by session.isSyncing.collectAsState()
                val draining by session.draining.collectAsState()
                val feed by session.feed.collectAsState()
                val link = rememberShownLinkState(status.linkState(syncing, network = true, draining = draining))
                shown.value = link
                when (screen.value) {
                    Screen.Chat -> {
                        val state by conversation.state.collectAsState()
                        ConversationScreen(
                            state = state,
                            actions = remember {
                                ConversationScreenActions(
                                    onBack = {}, onDraftChange = conversation::setDraft, onSend = { _, _ -> false }, onAnswer = conversation::answer,
                                    onOpenArtifact = {}, onRetryLoad = conversation::retryLoad, loadMedia = conversation::media, onVisible = conversation::setVisible,
                                )
                            },
                            link = link,
                        )
                    }
                    Screen.Home -> AgentHomeScreen("Studio", feed, status, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}), link = link)
                    Screen.Connection -> {
                        val lastError by session.client.lastServerError.collectAsState()
                        val state = ConnectionPageState(
                            status = if (draining) stringResource(R.string.link_status_restarting).replaceFirstChar { it.titlecase() } else statusText(status),
                            type = "Tailcat",
                            networkAvailable = true,
                            computer = "Studio",
                            lastError = lastError,
                        )
                        ConnectionDiagnosticsScreen(state, "test", onCopy = { true }, onBack = {})
                    }
                }
            }
        }
    }

    @Test fun aDrainingComputerSaysAgentRestartingUntilANewProcessSaysHello() = runBlocking {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val connections = connections()
        val computer = Computer()
        val id = connections.add(AgentConnectionCredentials("192.168.1.20", 7777, "studio-device", "token"), "Studio").id
        val shown = mutableStateOf(LinkState.Online)
        val session = AgentSession(id, connections, null, MutableStateFlow(true), scope, { computer })
        describe = { "status ${session.status.value}, draining ${session.draining.value}, shown ${shown.value}" }
        val screen = mutableStateOf(Screen.Home)
        screens(session, id, screen, shown)

        eventually("online", 30) { session.status.value == AgentLinkStatus.Connected && shown.value == LinkState.Online && session.feed.value.loaded }
        shot("1-home-online")

        // The daemon begins draining: it says so, and refuses a send.
        computer.draining = true
        computer.frames.trySend(DRAINING)
        eventually("restarting…") { shown.value == LinkState.Restarting }
        try { session.client.send("POST", "/v0/agents/ship-agent/send") } catch (_: AgentApiException) {}
        assertEquals("POST answered 503 (draining)", session.client.lastServerError.value)
        shot("2-home-agent-restarting")
        screen.value = Screen.Chat
        shot("3-chat-agent-restarting")
        screen.value = Screen.Connection
        eventually("the page says it") { rule.onAllNodesWithText("Agent restarting…", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        shot("4-connection-agent-restarting")
        screen.value = Screen.Home

        // A new process takes over.
        computer.restart("d2")
        eventually("online again", 30) { session.status.value == AgentLinkStatus.Connected && !session.draining.value && shown.value == LinkState.Online }
        shot("5-home-back-online")
        assertTrue(File(evidence, "2-home-agent-restarting.png").exists())
        session.close()
    }

    private companion object {
        fun hello(daemonId: String, draining: Boolean) =
            "event: hello\ndata: {\"cursor\":\"c1\",\"gap\":false,\"resumed\":true,\"daemonId\":\"$daemonId\",\"draining\":$draining}\n\n"

        val DRAINING = "id: c2\nevent: daemon.draining\ndata: {\"cursor\":\"c2\",\"type\":\"daemon.draining\",\"occurredAt\":1,\"payload\":{\"daemonId\":\"d1\",\"draining\":true}}\n\n"

        val HOME = """
            {"projects":[],"workspaces":[],"bots":[],"cursor":"c1","profile":{"userId":null},
             "tasks":[
               {"id":"ship","name":"Ship the cache","version":"01","status":"active","archivedAt":null,"agent":{"id":"ship-agent","workspaceId":"w1","version":"01","status":"idle","parentAgentId":null,"subtask":false,"userVisible":true,"title":null,"titleStatus":"idle","pendingQuestionId":null,"unread":null,"subtasks":[],"orderKey":null,"archivedAt":null,"createdAt":1,"updatedAt":2}},
               {"id":"old","name":"Old notes","version":"01","status":"active","archivedAt":null,"agent":{"id":"old-agent","workspaceId":"w2","version":"01","status":"idle","parentAgentId":null,"subtask":false,"userVisible":true,"title":null,"titleStatus":"idle","pendingQuestionId":null,"unread":null,"subtasks":[],"orderKey":null,"archivedAt":null,"createdAt":1,"updatedAt":3}}],
             "taskMemberships":[{"taskId":"ship","orderKey":"1"},{"taskId":"old","orderKey":"2"}]}
        """.trimIndent()
    }
}
