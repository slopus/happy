package com.slopus.happy.ui.viewers

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.size
import androidx.compose.material3.IconButton
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.todos.TodoActions
import com.slopus.happy.ui.todos.TodoListContent
import com.slopus.happy.viewers.Viewer
import com.slopus.happy.viewers.ViewerTarget
import com.slopus.happy.viewers.Viewers
import com.slopus.happy.viewers.ViewersBackend
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The header's viewers over an in-memory computer: the real [Viewers] store
 * and [ViewersSlot] in a real chat or todo list header, the computer
 * answering each heartbeat and sending `viewers.updated` as people come and go.
 *
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.viewers.ViewersFixturesActivity
 * --es viewers.screen chat|todo --es viewers.scene tiers|none|ten|live`. Each
 * heartbeat is logged under `ViewersFixture`.
 */
class ViewersFixturesActivity : ComponentActivity() {
    private val now get() = System.currentTimeMillis()
    private val names = listOf("Kirill", "Anna", "Max", "Sofia", "Leo", "Mia", "Noah", "Iris", "Omar", "Zoe", "Ivan")
    private val users = MutableStateFlow(names.associate { it.lowercase() to TeamUser(it.lowercase(), it) })

    /** The computer's side: who is on each target. */
    private val truth = MutableStateFlow<Map<ViewerTarget, List<Viewer>>>(emptyMap())

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val screen = intent.getStringExtra(SCREEN) ?: "chat"
        val scene = intent.getStringExtra(SCENE) ?: "tiers"
        val target = if (screen == "todo") ViewerTarget.surface("launch") else ViewerTarget.agent("a1")
        truth.value = mapOf(target to Viewers.ordered(start(scene)))
        val backend = ViewersBackend { streamId, targets ->
            Log.i(TAG, "PUT /v0/viewers/streams/$streamId ${targets.map { "${it.type}:${it.id}" }}")
            targets.associateWith { truth.value[it].orEmpty() }
        }
        val viewers = Viewers(lifecycleScope, backend)
        viewers.opened("fixture-stream")
        val slot = @androidx.compose.runtime.Composable { ViewersSlot(viewers, users, null, target) }
        if (screen == "todo") {
            setContent {
                HappyTheme {
                    ProvideWindowLayout {
                        PlaceScaffold("Launch checklist", onBack = {}, tag = "todo.screen", actions = {
                            slot()
                            IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(Ionicon.EllipsisVertical, 24.dp, HappyTheme.colors.text, contentDescription = null) }
                        }) { TodoListContent(todos(), remember { noTodoActions() }) }
                    }
                }
            }
        } else {
            val conversation = Conversation(
                api = ConversationApi(chatRequest()),
                signals = MutableSharedFlow<ConversationSignal>(),
                scope = lifecycleScope,
                agentId = "a1",
                knownTitle = "Fix the flaky login test",
            )
            conversation.start()
            setContent {
                HappyTheme {
                    ProvideWindowLayout {
                        val state by conversation.state.collectAsState()
                        ConversationScreen(state, remember { ConversationScreenActions() }, viewers = slot)
                    }
                }
            }
        }
        if (scene == "live") lifecycleScope.launch { play(viewers, target) }
    }

    private fun person(name: String, here: Boolean, minutesAgo: Long) = Viewer(name.lowercase(), here, now - minutesAgo * 60_000)

    private fun start(scene: String): List<Viewer> = when (scene) {
        "none" -> emptyList()
        "ten" -> names.take(10).mapIndexed { i, name -> person(name, here = i % 3 == 0, minutesAgo = (i * 7).toLong()) }
        "live" -> listOf(person("Max", false, 14 * 24 * 60), person("Leo", false, 3))
        else -> listOf(person("Kirill", true, 0), person("Sofia", true, 0), person("Anna", false, 4), person("Max", false, 14 * 24 * 60))
    }

    /** People come and go, a frame each, over and over: one arrives, another, one leaves, they come back. */
    private suspend fun play(viewers: Viewers, target: ViewerTarget) {
        val steps = listOf("kirill" to true, "anna" to true, "sofia" to true, "kirill" to false, "anna" to false, "kirill" to true, "sofia" to false, "anna" to true)
        delay(2_000)
        while (true) {
            for ((id, here) in steps) {
                val viewer = Viewer(id, here, now)
                truth.update { it + (target to Viewers.ordered(it[target].orEmpty().filter { v -> v.userId != id } + viewer)) }
                viewers.frame("""{"target":{"type":"${target.type.name.lowercase()}","id":"${target.id}"},"viewer":{"userId":"$id","here":$here,"lastSeenAt":${viewer.lastSeenAt}}}""")
                Log.i(TAG, "frame $id here=$here")
                delay(3_000)
            }
        }
    }

    private fun todos(): TodoListState {
        val texts = listOf("Draft the release notes", "Record the onboarding video", "Check crash-free rate", "Ship 2026.11.2 to beta", "Book the retro")
        return TodoListState(
            status = TodoListState.Status.Ready,
            active = texts.mapIndexed { i, text -> TodoItem("t$i", "launch", text, orderKey = "a$i", authorUserId = "anna") },
        )
    }

    private fun noTodoActions() = TodoActions(
        add = {}, edit = { _, _ -> }, done = { _, _ -> }, delete = {}, restore = { _, _, _ -> }, move = { _, _ -> },
        history = {}, refresh = {}, dismissFailure = {},
    )

    private fun chatRequest(): AgentRequest {
        val start = now
        fun ok(text: String) = TransportResponse(200, body = text.toByteArray())
        fun text(words: String) = """{"type":"text","text":"$words"}"""
        fun user(id: String, at: Long, words: String) = """{"id":"$id","role":"user","createdAt":$at,"status":"accepted","content":[${text(words)}]}"""
        fun agent(id: String, at: Long, words: String) = """{"id":"$id","role":"agent","createdAt":$at,"content":[${text(words)}]}"""
        val page = """{"runs":[{"id":"r0","status":"completed","startedAt":${start - 600_000},"endedAt":${start - 420_000},"reason":"completed","messages":[""" +
            listOf(
                user("u0", start - 600_000, "Why does LoginTest fail on CI?"),
                agent("m0", start - 598_000, "Let me look at the test and its last runs."),
                agent("m1", start - 430_000, "It races the splash screen: the test taps before the form is shown. Waiting for the form fixes it."),
            ).joinToString(",") + "]}],\"hasMore\":false}"
        return { _, path, _, _ ->
            when {
                path.substringBefore('?').endsWith("/bootstrap") -> ok("""{"agent":{"id":"a1","workspaceId":"w1","status":"idle","title":"Fix the flaky login test"},"mode":null,"draft":{"value":null,"updatedAt":null},"pending":[]}""")
                path.substringBefore('?').endsWith("/messages") && "before=" !in path -> ok(page)
                else -> ok("{}")
            }
        }
    }

    private companion object {
        const val TAG = "ViewersFixture"
        const val SCREEN = "viewers.screen"
        const val SCENE = "viewers.scene"
    }
}
