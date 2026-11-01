package com.slopus.happy.ui.connection

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.AgentSessions
import com.slopus.happy.agent.FakeAgent
import com.slopus.happy.agent.Wire
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Leaving a Surface from home, end to end over a fake agent: hold the row,
 * Leave, confirm; the row goes at once and `POST /v0/surfaces/:id/leave`
 * goes out; a refusal brings the row back and says why. Cancel leaves it be.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentHomeLeaveTest {
    @get:Rule val rule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val agent = FakeAgent(
        Wire.bootstrap(
            bots = listOf(Wire.bot("b1", "Happy", Wire.agent("ab1"))),
            surfaces = listOf(Wire.surface("s1", "Groceries", "todo"), Wire.surface("s2", "Launch plan", "document", mapOf(Wire.USER to "2"))),
        ),
    )
    private val cacheDir = File(context.cacheDir, "agent-home-leave-test")
    private val accounts = AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true)))
    private lateinit var connections: AgentConnections
    private lateinit var id: String

    /** The leave's answer waits for this. */
    private val gate = CompletableDeferred<Unit>()
    private val leaves = mutableListOf<String>()

    @Before
    fun setUp(): Unit = runBlocking {
        cacheDir.deleteRecursively()
        val secrets = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { agent })
        id = connections.add(AgentConnectionCredentials("addr", 24781, "dv1", "token"), "Mac").id
    }

    @After
    fun tearDown() = scope.cancel()

    /** A session whose leave answers [status], with [error] as the agent's words. */
    private fun session(status: Int, error: String?): AgentSession {
        val sessions = AgentSessions(connections, scope, cacheDir, MutableStateFlow<String?>(id), MutableStateFlow(true)) {
            object : Transport by agent {
                override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
                    if (!path.endsWith("/leave")) return agent.request(method, path, credential, body, headers)
                    synchronized(leaves) { leaves += "$method $path" }
                    gate.await()
                    val text = if (status in 200..299) "{}" else "{\"error\":${error?.let { "\"$it\"" } ?: "null"},\"code\":\"refused\"}"
                    return TransportResponse(status, mapOf("content-type" to "application/json"), text.toByteArray())
                }
            }
        }
        return sessions.session(id)!!
    }

    private fun show(session: AgentSession) {
        val actions = AgentHomeActions({}, {}, {}, {}, {}, {}, onLeaveSurface = { session.leaveSurface(it.id) })
        rule.setHappyContent {
            val feed by session.feed.collectAsState()
            AgentHomeScreen("Studio", feed, AgentLinkStatus.Connected, accounts, actions)
        }
        rule.waitUntil(10_000) { rows("surface-s1") == 1 }
    }

    private fun rows(key: String) = rule.onAllNodesWithTag(AgentHomeTags.row(key), useUnmergedTree = true).fetchSemanticsNodes().size

    private fun holdAndLeave() {
        rule.node(AgentHomeTags.row("surface-s1")).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.node(AgentHomeTags.LEAVE).assertIsDisplayed().performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Leave “Groceries”?").assertIsDisplayed()
    }

    @Test
    fun leaveAsksFirstThenTheRowGoesAtOnceAndTheAgentIsAsked() {
        show(session(200, null))
        holdAndLeave()
        rule.onNodeWithText("Leave").performClick()
        rule.waitUntil(10_000) { rows("surface-s1") == 0 }
        rule.waitUntil(10_000) { synchronized(leaves) { leaves.isNotEmpty() } }
        assertEquals(listOf("POST /v0/surfaces/s1/leave"), synchronized(leaves) { leaves.toList() })
        gate.complete(Unit)
        rule.waitForIdle()
        Thread.sleep(200)
        rule.waitForIdle()
        assertEquals("Left, it stays gone", 0, rows("surface-s1"))
        assertEquals(1, rows("surface-s2"))
        assertEquals(0, rule.onAllNodesWithTag(AgentHomeTags.LEAVE, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    fun aRefusalBringsTheRowBackAndSaysWhy() {
        show(session(409, "Only members can leave."))
        holdAndLeave()
        rule.onNodeWithText("Leave").performClick()
        rule.waitUntil(10_000) { rows("surface-s1") == 0 }
        gate.complete(Unit)
        rule.waitUntil(10_000) { rows("surface-s1") == 1 }
        rule.onNodeWithText("Couldn't leave “Groceries”").assertIsDisplayed()
        rule.onNodeWithText("Only members can leave.").assertIsDisplayed()
        rule.onNodeWithText("OK").performClick()
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithTag(AgentHomeTags.LEAVE, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    fun anAgentThatGivesNoWordsIsSaidNotToHaveAnswered() {
        show(session(503, null))
        holdAndLeave()
        rule.onNodeWithText("Leave").performClick()
        gate.complete(Unit)
        rule.waitUntil(10_000) { rule.onAllNodesWithText("The agent didn't answer. Try again in a moment.").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1, rows("surface-s1"))
    }

    @Test
    fun cancelLeavesItBe() {
        show(session(200, null))
        holdAndLeave()
        rule.onNodeWithText("Cancel").performClick()
        rule.waitForIdle()
        Thread.sleep(200)
        assertEquals(1, rows("surface-s1"))
        assertTrue(synchronized(leaves) { leaves.isEmpty() })
    }
}
