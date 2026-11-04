package com.slopus.happy.ui.todos

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.waitUntilAtLeastOneExists
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.cards.CardListTags
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalTestApi::class)
class TodoListsScreenTest {
    @get:Rule val rule = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val created = AtomicReference<JsonObject?>(null)
    private val fixtures = listOf(Wire.surface("s1", "Groceries", "todo"), Wire.surface("s2", "Someone else", "todo", mapOf("u2" to "1")), Wire.surface("s3", "Notes", "document"))
    private val agent = FakeAgent(Wire.bootstrap(surfaces = fixtures))
    private val daemon = object : Transport by agent {
        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse {
            if (path != "/v0/surfaces") return agent.request(method, path, credential, body, headers, category)
            val reply = if (method == "GET") buildJsonObject { put("surfaces", JsonArray(fixtures)); put("cursor", "c0") }
            else {
                val request = Json.parseToJsonElement(requireNotNull(body).decodeToString()).jsonObject
                created.set(request)
                buildJsonObject { put("surface", Wire.surface(request.getValue("id").jsonPrimitive.content, request.getValue("name").jsonPrimitive.content, request.getValue("type").jsonPrimitive.content)) }
            }
            return TransportResponse(200, body = reply.toString().toByteArray())
        }
    }
    private fun session(): AgentSession = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secrets = context.getSharedPreferences("todo-index-secrets", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val registry = context.getSharedPreferences("todo-index-registry", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val connections = AgentConnections(ExpoSecureStore(secrets, SoftwareKeys(), keychainService = AgentConnections.KEYCHAIN_SERVICE), registry, makeTransport = { daemon })
        val id = connections.add(AgentConnectionCredentials("test", 24781, "dv1", "token"), "Test").id
        val cache = File(context.cacheDir, "todo-index-test").also { it.deleteRecursively() }
        AgentSessions(connections, scope, cache, MutableStateFlow(id), MutableStateFlow(true), makeTransport = { daemon }).session(id)!!
    }
    @After fun close() = scope.cancel()

    @Test fun indexShowsOnlyJoinedTodosAndCreatesWithARequiredName() {
        val session = session()
        var opened: String? = null
        rule.setHappyContent { TodoListsScreen(session, {}, { opened = it }) }
        rule.waitUntilAtLeastOneExists(hasTestTag("todo.lists.s1"), 5_000)
        rule.node("todo.lists.s2").assertDoesNotExist()
        rule.node("todo.lists.s3").assertDoesNotExist()
        assertDp("card column", 0, rule.node("todo.lists.s1").bounds.left)
        assertDp("leading keyline", 32, rule.node(CardListTags.LEADING).bounds.left)
        assertTrue(rule.node("todo.lists.s1").bounds.top >= rule.node("place.bar").bounds.bottom)
        rule.node("todo.lists.s1").performClick()
        assertEquals("s1", opened)
        rule.node("todo.lists.new").performClick()
        rule.node("todo.lists.new.list").performClick()
        rule.node("prompt.confirm").assertIsNotEnabled()
        rule.node("prompt.input").performTextReplacement("  Weekend  ")
        rule.node("prompt.confirm").performClick()
        rule.waitUntil(5_000) { created.get() != null && opened != "s1" }
        assertEquals("Weekend", created.get()?.get("name")?.jsonPrimitive?.content)
        assertEquals("todo", created.get()?.get("type")?.jsonPrimitive?.content)
        assertEquals(created.get()?.get("id")?.jsonPrimitive?.content, opened)
    }
}