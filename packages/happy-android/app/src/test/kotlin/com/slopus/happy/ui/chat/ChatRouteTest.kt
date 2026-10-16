package com.slopus.happy.ui.chat

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** `/session/{id}` end to end over the local store: records → reducer → rows. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatRouteTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var graph: AppGraph

    @Before
    fun setUp() {
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = "http://127.0.0.1:1",
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        graph.store.upsertSessions(
            listOf(
                SessionRecord(
                    "s1", 2, 1, 1, true, 1,
                    """{"path":"/home/me/app","host":"devbox","summary":{"text":"Port the chat","updatedAt":1}}""", 1,
                    null, 1, "", null,
                ),
            ),
        )
        graph.store.insertMessages(
            "s1",
            listOf(
                MessageRecord("s1", 1, "m1", "l1", """{"role":"user","content":{"type":"text","text":"Can you port it?"}}""", 1, 1),
                MessageRecord(
                    "s1", 2, "m2", null,
                    """{"role":"session","content":{"id":"e1","time":2,"role":"agent","turn":"t","ev":{"t":"text","text":"Ported, **with tests**."}}}""",
                    2, 2,
                ),
            ),
        )
    }

    private fun open(id: String) {
        rule.setHappyContent {
            val nav = rememberNavController()
            NavHost(nav, startDestination = SessionRoute(id)) { chatRoutes(graph, nav) }
        }
    }

    @Test
    fun opensAStoredSession() {
        open("s1")
        rule.waitUntilAtLeastOneExists(hasText("Ported, with tests."), 5_000)
        rule.onNodeWithText("Can you port it?").assertExists()
        rule.onNodeWithText("Port the chat").assertExists()
    }

    @Test
    fun sendingSignedOutSaysSoAndKeepsTheDraft() {
        open("s1")
        rule.waitUntilAtLeastOneExists(hasText("Ported, with tests."), 5_000)
        rule.node(ComposerTags.INPUT).performTextInput("next step")
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.waitUntilAtLeastOneExists(hasText("Not signed in"), 5_000)
        rule.onNodeWithText("next step").assertExists()
    }

    /** Outbox rows stand in for their echo: queued ones dim, failed ones offer retry and discard. */
    @Test
    fun outboxRowsShowTheirDelivery() {
        fun row(localId: String, text: String, state: OutboxState, error: String? = null) = OutboxRecord(
            localId = localId, sessionId = "s1", kind = OutboxKind.USER,
            recordJson = """{"role":"user","content":{"type":"text","text":"$text"}}""", content = "",
            createdAt = 10, state = state, attempts = 1, error = error, serverId = null, serverSeq = null,
        )
        graph.store.enqueueOutbox(listOf(row("o1", "queued one", OutboxState.QUEUED), row("o2", "broken one", OutboxState.FAILED, "HTTP 500")))
        open("s1")
        rule.waitUntilAtLeastOneExists(hasText("broken one"), 5_000)
        rule.onNodeWithText("queued one").assertExists()
        rule.onNodeWithText("Not sent: HTTP 500").assertExists()
        rule.node(MessageTags.USER_RETRY).assertExists()
        rule.node(MessageTags.USER_DISCARD).assertExists()
    }

    @Test
    fun aSessionNotOnTheDeviceReadsAsDeleted() {
        open("gone")
        rule.waitUntilAtLeastOneExists(hasText("This session has been permanently removed"), 5_000)
    }
}
