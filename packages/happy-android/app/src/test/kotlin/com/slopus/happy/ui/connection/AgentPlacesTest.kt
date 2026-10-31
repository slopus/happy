package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.ArtifactSummary
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.Todo
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Home's Artifacts and Surface pages: what they read, and what they show. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class AgentPlacesTest {
    @get:Rule val rule = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val asked = mutableListOf<String>()
    private val sent = mutableListOf<JsonElement?>()

    @After
    fun tearDown() = scope.cancel()

    private fun api(answer: (method: String, path: String) -> String) = ConversationApi { method, path, body ->
        synchronized(asked) { asked += "$method $path"; sent += body }
        TransportResponse(200, body = answer(method, path).toByteArray())
    }

    private fun <T> await(flow: kotlinx.coroutines.flow.StateFlow<PlaceRead<T>>, test: (T) -> Boolean): T = runBlocking {
        withTimeout(5_000) { (flow.first { it is PlaceRead.Ready && test(it.value) } as PlaceRead.Ready).value }
    }

    @Test
    fun artifactsArePagedAndReadAgainFromTheTop() {
        val api = api { _, path ->
            if (path.endsWith("pageCursor=p2")) {
                """{"artifacts":[{"id":"a2","title":"Two"},{"id":"a3"}],"nextPageCursor":null}"""
            } else {
                """{"artifacts":[{"id":"a1","title":"One"},{"id":"a2","title":"Two"}],"nextPageCursor":"p2"}"""
            }
        }
        val reader = ArtifactCatalogReader(api, scope)
        reader.read()
        assertEquals("p2", await(reader.state) { true }.next)
        reader.read(append = true)
        val all = await(reader.state) { it.next == null }
        // A repeated id is shown once; an untitled one has no title.
        assertEquals(listOf(ArtifactSummary("a1", "One"), ArtifactSummary("a2", "Two"), ArtifactSummary("a3", null)), all.items)
        // At the end, asking for more asks nothing.
        reader.read(append = true)
        Thread.sleep(100)
        assertEquals(listOf("GET /v0/artifacts", "GET /v0/artifacts?pageCursor=p2"), asked)
    }

    @Test
    fun aTodoListReadsBothScopesAndAddsAtTheTop() {
        val api = api { method, path ->
            when {
                method == "POST" -> """{"todo":{"id":"n"}}"""
                path.endsWith("scope=completed") -> """{"todos":[{"id":"t2","text":"Milk","status":"completed"}]}"""
                else -> """{"todos":[{"id":"t1","text":"Eggs","status":"active"}]}"""
            }
        }
        val reader = SurfaceReader(api, scope, "s1", "todo")
        reader.read()
        assertEquals(
            SurfaceBody.Todos(listOf(Todo("t1", "Eggs", false), Todo("t2", "Milk", true))),
            await(reader.state) { true },
        )
        assertTrue(reader.hears(AgentEvent(null, "todo.created", buildJsonObject { put("surfaceId", "s1") })))
        assertTrue(reader.hears(AgentEvent(null, "todo.updated", buildJsonObject { put("todo", buildJsonObject { put("surfaceId", "s1") }) })))
        assertFalse(reader.hears(AgentEvent(null, "todo.created", buildJsonObject { put("surfaceId", "s2") })))
        reader.add("   ")
        reader.add("  Bread ")
        runBlocking { withTimeout(5_000) { while (synchronized(asked) { asked.count { it.startsWith("GET") } } < 4) kotlinx.coroutines.delay(10) } }
        val post = synchronized(asked) { asked.indexOf("POST /v0/surfaces/todo/s1") }
        assertTrue(post >= 0)
        assertEquals("Bread", sent[post]!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals(1, asked.count { it.startsWith("POST") })
    }

    @Test
    fun aDocumentIsItsMarkdownAndAnythingElseIsForTheComputer() {
        val reader = SurfaceReader(api { _, _ -> """{"document":{"text":"# Plan\n\nShip it."}}""" }, scope, "s2", "document")
        reader.read()
        assertEquals(SurfaceBody.Document("# Plan\n\nShip it."), await(reader.state) { true })
        val calendar = SurfaceReader(api { _, _ -> error("not read") }, scope, "s3", "calendar")
        calendar.read()
        assertEquals(PlaceRead.Ready(SurfaceBody.Elsewhere), calendar.state.value)
        assertEquals(listOf("GET /v0/surfaces/document/s2"), asked)
    }

    @Test
    fun theTodoPageShowsTodosAndTakesANewOne() {
        val added = mutableListOf<String>()
        rule.setHappyContent {
            SurfaceScreen("Groceries", PlaceRead.Ready(SurfaceBody.Todos(listOf(Todo("t1", "Eggs", false), Todo("t2", "Milk", true)))), {}, { added += it }, {})
        }
        rule.onNodeWithText("Groceries").assertExists()
        rule.onAllNodesWithTag(AgentPlacesTags.TODO).assertCountEquals(2)
        rule.node(AgentPlacesTags.TODO_FIELD).performTextInput("Bread")
        rule.node(AgentPlacesTags.TODO_FIELD).performImeAction()
        assertEquals(listOf("Bread"), added)
    }

    @Test
    fun theArtifactsPageOpensAnArtifact() {
        val opened = mutableListOf<String>()
        rule.setHappyContent {
            ArtifactsScreen(PlaceRead.Ready(ArtifactPages(listOf(ArtifactSummary("a1", "Report"), ArtifactSummary("a2", null)), null)), {}, { opened += it }, {}, {})
        }
        rule.onNodeWithText("Artifacts").assertExists()
        rule.onNodeWithText("Untitled").assertExists()
        rule.onNodeWithText("Report").performClick()
        assertEquals(listOf("a1"), opened)
    }

    @Test
    fun otherSurfacesSayToUseTheComputer() {
        rule.setHappyContent { SurfaceScreen("Week", PlaceRead.Ready(SurfaceBody.Elsewhere), {}, {}, {}) }
        rule.onNodeWithText("Open this on your computer to use it.").assertExists()
    }
}
