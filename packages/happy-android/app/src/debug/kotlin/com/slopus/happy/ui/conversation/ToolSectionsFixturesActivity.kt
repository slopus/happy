package com.slopus.happy.ui.conversation

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.lifecycleScope
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ConversationSignal
import com.slopus.happy.ui.connection.AgentAppearanceScreen
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/**
 * A Happy Agent chat over an in-memory computer, for Group tool calls
 * ([com.slopus.happy.conversation.ToolSections]): the real [Conversation]
 * and [ConversationScreen], fed a scripted history and live run.
 *
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.conversation.ToolSectionsFixturesActivity
 * --ez grouped true --es scenario live` (or `rest`: a run under way, its
 * sections, a one-call section and an answered question drawn at rest;
 * `settings`: the connection's Appearance page with the switch).
 */
class ToolSectionsFixturesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val grouped = MutableStateFlow(intent.getBooleanExtra(GROUPED, true))
        val scenario = intent.getStringExtra(SCENARIO) ?: "live"
        val script = Script(System.currentTimeMillis(), rest = scenario == "rest")
        val signals = MutableSharedFlow<ConversationSignal>(extraBufferCapacity = 64)
        val conversation = Conversation(
            api = ConversationApi(script.request),
            signals = signals,
            scope = lifecycleScope,
            agentId = "a1",
            knownTitle = "Fix the flaky login test",
            grouped = grouped,
        )
        conversation.start()
        setContent {
            HappyTheme {
                ProvideWindowLayout {
                    if (scenario == "settings") {
                        val on by grouped.collectAsState()
                        AgentAppearanceScreen(ThemePreference.Adaptive, {}, false, {}, {}, toolCallsGrouped = on, onToolCallsGrouped = { grouped.value = it })
                    } else {
                        val state by conversation.state.collectAsState()
                        ConversationScreen(state, remember { ConversationScreenActions(onToggleTurn = conversation::toggleTurn) })
                    }
                }
            }
        }
        if (scenario == "live") lifecycleScope.launch {
            delay(intent.getLongExtra(START_DELAY, 2_500))
            script.play(signals, intent.getLongExtra(STEP, 900))
        }
    }

    private class Script(val now: Long, val rest: Boolean) {
        val request: AgentRequest = { _, path, _, _ ->
            val route = path.substringBefore('?')
            when {
                route.endsWith("/bootstrap") -> ok(bootstrap())
                route.endsWith("/messages") && "before=" !in path -> ok(page())
                else -> ok("{}")
            }
        }

        private fun bootstrap() =
            """{"agent":{"id":"a1","workspaceId":"w1","status":"${if (rest) "running_tools" else "idle"}","title":"Fix the flaky login test"},"mode":null,"draft":{"value":null,"updatedAt":null},"pending":[]}"""

        private fun page(): String {
            val earlier = run(
                "r0", now - 600_000, now - 420_000,
                user("u0", now - 600_000, "Why does LoginTest fail on CI?"),
                agent("m0", now - 598_000, text("Let me look at the test and its last runs.")),
                agent("m1", now - 595_000, explore("t01", "read", "LoginTest.kt"), command("t02", "./gradlew :app:test --tests LoginTest"), explore("t03", "search", query = "waitForIdle")),
                agent("m2", now - 430_000, text("It races the splash screen: the test taps before the form is shown.")),
            )
            if (!rest) return """{"runs":[$earlier],"hasMore":false}"""
            val going = run(
                "r1", now - 300_000, null,
                user("u1", now - 300_000, "Fix it, and ask me before touching CI."),
                agent("m3", now - 298_000, text("First the test itself.")),
                agent(
                    "m4", now - 296_000,
                    explore("t11", "read", "LoginTest.kt"), explore("t12", "read", "LoginScreen.kt"), command("t13", "./gradlew :app:test --tests LoginTest"),
                    explore("t14", "read", "SplashGate.kt"), diff("t15", "LoginTest.kt", 4, 9), command("t16", "./gradlew :app:test --tests LoginTest", status = "failed"),
                ),
                agent("m5", now - 104_000, text("The test waits for the form now. Should CI retry flaky tests?"), question("q1")),
                agent("m6", now - 60_000, text("Keeping CI as it is. One more look at the gate:")),
                agent("m7", now - 58_000, explore("t17", "read", "SplashGate.kt")),
                agent("m8", now - 40_000, text("That is the only caller. Running the whole suite once more.")),
                agent("m9", now - 38_000, command("t18", "./gradlew :app:testDebugUnitTest", status = "running")),
            )
            return """{"runs":[$earlier,$going],"hasMore":false}"""
        }

        /** The live run, a call at a time, [step] apart. */
        suspend fun play(signals: MutableSharedFlow<ConversationSignal>, step: Long) {
            val start = System.currentTimeMillis()
            fun at(seconds: Int) = start + seconds * 1_000L
            suspend fun emit(type: String, payload: String) {
                signals.emit(ConversationSignal.Event(type, Json.parseToJsonElement(payload).jsonObject))
            }
            suspend fun message(json: String) = emit("message.updated", """{"runId":"r1","message":$json}""")
            emit("message.created", """{"message":${user("u1", at(0), "Fix it, then run the suite.")}}""")
            emit("run.started", """{"run":{"id":"r1","status":"running","startedAt":${at(0)}},"acceptedMessageIds":["u1"]}""")
            emit("message.updated", """{"runId":"r1","message":${user("u1", at(0), "Fix it, then run the suite.")}}""")
            delay(step)
            message(agent("m3", at(1), text("First the test itself.")))
            delay(step)
            val calls = listOf(
                { s: String -> explore("t11", "read", "LoginTest.kt", s) },
                { s: String -> explore("t12", "read", "LoginScreen.kt", s) },
                { s: String -> command("t13", "./gradlew :app:test --tests LoginTest", s) },
                { s: String -> explore("t14", "search", query = "waitForIdle", status = s) },
                { s: String -> diff("t15", "LoginTest.kt", 4, 9, s) },
                { s: String -> command("t16", "./gradlew :app:test --tests LoginTest", if (s == "completed") "failed" else s) },
                { s: String -> command("t17", "./gradlew :app:test --tests LoginTest", s) },
            )
            val done = ArrayList<String>()
            for (call in calls) {
                message(agent("m4", at(2), *(done + call("running")).toTypedArray()))
                delay(step)
                done += call("completed")
                message(agent("m4", at(2), *done.toTypedArray()))
                delay(step / 2)
            }
            delay(step)
            message(agent("m5", at(74), text("The test waits for the form now. One more look at the gate:")))
            delay(step * 2)
            message(agent("m6", at(76), explore("t18", "read", "SplashGate.kt", "running")))
            delay(step)
            message(agent("m6", at(76), explore("t18", "read", "SplashGate.kt", "completed")))
            delay(step)
            message(agent("m7", at(80), text("That is the only caller, so the fix holds. The suite passes.")))
            delay(step)
            emit("run.finished", """{"run":{"id":"r1","status":"completed","startedAt":${at(0)},"endedAt":${at(82)},"reason":"completed"}}""")
        }

        companion object {
            fun ok(text: String) = TransportResponse(200, body = text.toByteArray())

            fun run(id: String, startedAt: Long, endedAt: Long?, vararg messages: String) =
                """{"id":"$id","status":"${if (endedAt == null) "running" else "completed"}","startedAt":$startedAt${endedAt?.let { ""","endedAt":$it,"reason":"completed"""" }.orEmpty()},"messages":[${messages.joinToString(",")}]}"""

            fun user(id: String, at: Long, words: String) =
                """{"id":"$id","role":"user","createdAt":$at,"status":"accepted","content":[${text(words)}]}"""

            fun agent(id: String, at: Long, vararg blocks: String) =
                """{"id":"$id","role":"agent","createdAt":$at,"content":[${blocks.joinToString(",")}]}"""

            fun text(words: String) = """{"type":"text","text":"$words"}"""

            fun explore(id: String, kind: String, name: String? = null, status: String = "completed", query: String? = null): String {
                val operation = if (kind == "read") """{"kind":"read","name":"$name"}""" else """{"kind":"search","query":"$query","path":"app/src"}"""
                return """{"type":"tool_call","id":"$id","name":"${if (kind == "read") "Read" else "Grep"}","status":"$status","presentation":{"type":"exploration","operations":[$operation]}}"""
            }

            fun command(id: String, command: String, status: String = "completed") =
                """{"type":"tool_call","id":"$id","name":"Bash","status":"$status","presentation":{"type":"exec_command","command":"$command"}}"""

            fun diff(id: String, path: String, added: Int, deleted: Int, status: String = "completed") =
                """{"type":"tool_call","id":"$id","name":"Edit","status":"$status","presentation":{"type":"file_diff","files":[{"path":"app/src/test/$path","kind":"update","added":$added,"deleted":$deleted,"hunks":[]}]}}"""

            fun question(id: String) =
                """{"type":"tool_call","id":"$id","name":"request_user_input","status":"completed","presentation":{"type":"user_input","questions":[{"id":"ci","header":"CI retries","question":"Should CI retry flaky tests?","options":[{"label":"No, keep CI as it is"},{"label":"Retry once"}]},{"id":"scope","header":"Scope","question":"Which tests?","options":[{"label":"Only LoginTest"}]}],"answers":{"ci":["No, keep CI as it is"],"scope":["Only LoginTest"]}}}"""
        }
    }

    private companion object {
        const val GROUPED = "grouped"
        const val SCENARIO = "scenario"
        const val START_DELAY = "startDelay"
        const val STEP = "step"
    }
}
