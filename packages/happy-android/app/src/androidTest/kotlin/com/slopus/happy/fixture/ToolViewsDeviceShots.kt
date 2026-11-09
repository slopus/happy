package com.slopus.happy.fixture

import android.os.SystemClock
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.WorkspaceGit
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ToolCallReader
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.ToolCallActions
import com.slopus.happy.ui.conversation.ToolCallModel
import com.slopus.happy.ui.conversation.ToolCallScreen
import com.slopus.happy.ui.conversation.ToolCallScreenState
import com.slopus.happy.ui.conversation.ToolCallTags
import com.slopus.happy.ui.conversation.TurnRowTags
import com.slopus.happy.ui.diff.DiffTags
import com.slopus.happy.ui.files.AgentChanges
import com.slopus.happy.ui.files.ChangesActions
import com.slopus.happy.ui.files.ChangesContent
import com.slopus.happy.ui.files.ChangesScreen
import com.slopus.happy.ui.files.MessageDetailTags
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.emptyFlow
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Tool calls on a device, over a made-up agent that exists only in this
 * test's memory: the chat's tool lines, a command's screen, an edit's
 * screen and one of its files alone, and the workspace's changes. The real
 * Conversation, ToolCallModel and its reader, ToolCallScreen, WorkspaceGit
 * and ChangesScreen run; the agent connection and the app's nav graph do
 * not. Every call, file and diff is synthetic. Shots go to the app's
 * external files under `tool-views/`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class ToolViewsDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val dir = File(app.getExternalFilesDir(null), "tool-views").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val requests = ArrayList<String>()

    @After fun stop() = scope.cancel()

    private val request: AgentRequest = { method, path, _, _ ->
        synchronized(requests) { requests += "$method $path" }
        val route = path.substringBefore('?')
        val body = when {
            route == "/v0/agents/$AGENT/bootstrap" -> BOOTSTRAP
            route == "/v0/agents/$AGENT/messages" -> PAGE
            route == "/v0/config" -> CONFIG
            route == "/v0/workspaces/$WORKSPACE/git" -> GIT
            route == "/v0/workspaces/$WORKSPACE/file-revision" -> content(BASE.getValue(file(path)))
            route == "/v0/workspaces/$WORKSPACE/file" -> """{"content":"${b64(WORKING.getValue(file(path)))}","hash":"${"b".repeat(64)}"}"""
            method != "GET" -> "{}"
            else -> null
        }
        if (body == null) TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
        else TransportResponse(200, mapOf("content-type" to "application/json"), body.toByteArray())
    }

    private fun file(path: String) = java.net.URLDecoder.decode(path.substringAfter("path=").substringBefore('&'), "UTF-8")
    private fun b64(text: String) = Base64.encodeToString(text.toByteArray(), Base64.NO_WRAP)
    private fun content(text: String) = """{"content":"${b64(text)}"}"""

    @Composable
    private fun Screens() {
        val nav = rememberNavController()
        val conversation = remember { Conversation(ConversationApi(request), emptyFlow(), scope, AGENT).also { it.start() } }
        val reader = remember { ToolCallReader(ConversationApi(request), AGENT) }
        NavHost(nav, startDestination = "chat") {
            composable("chat") {
                val state by conversation.state.collectAsStateWithLifecycle()
                ConversationScreen(
                    state = state,
                    actions = remember(nav) {
                        ConversationScreenActions(onBack = {}, onVisible = conversation::setVisible, onOpenTool = { id -> nav.navigate("tool/$id") })
                    },
                )
            }
            composable("tool/{id}?file={file}") { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                val file = entry.arguments?.getString("file")
                val model = remember(id) { ToolCallModel(reader, id, conversation) }
                LaunchedEffect(model) { model.observe() }
                val read by model.state.collectAsStateWithLifecycle()
                ToolCallScreen(
                    ToolCallScreenState(read.call, read.reading, read.readingWhole, read.wholeFailed, file = file),
                    ToolCallActions(onBack = { nav.popBackStack() }, onOpenFile = { path -> nav.navigate("tool/$id?file=$path") }),
                )
            }
            composable("changes") {
                val changesScope = rememberCoroutineScope()
                val changes = remember { AgentChanges(changesScope, WorkspaceGit(request, WORKSPACE), WORKSPACE, supported = true) }
                LaunchedEffect(changes) { changes.refresh() }
                val state by changes.state.collectAsStateWithLifecycle()
                ChangesScreen(
                    ChangesContent.Agent(state, supported = true, expandFew = true),
                    ChangesActions(onBack = { nav.popBackStack() }, onRequestContent = changes::requestContent, onExpandContext = changes::expandContext),
                )
            }
        }
        LaunchedEffect(Unit) { navigate = { nav.navigate(it) } }
    }

    private var navigate: (String) -> Unit = {}

    private fun show() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { HappyTheme { Screens() } }
        waitFor(TurnRowTags.TOOL)
    }

    private fun waitFor(tag: String, count: Int = 1) =
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size >= count }

    private fun capture(name: String) {
        rule.waitForIdle()
        SystemClock.sleep(900)
        device.takeScreenshot(File(dir, "$name.png"))
        android.util.Log.i("ToolViews", "captured $name; in front: ${device.currentPackageName}")
    }

    private fun openLine(text: String, substring: Boolean = true) {
        rule.onAllNodes(hasTestTag(TurnRowTags.TOOL) and hasText(text, substring = substring)).onFirst().performScrollTo().performClick()
        waitFor(ToolCallTags.SCREEN)
    }

    @Test fun chatAndCalls() {
        show()
        capture("1-chat-tool-lines")

        openLine("pnpm test")
        waitFor(MessageDetailTags.COMMAND)
        capture("2-exec-command")
        device.pressBack()
        waitFor(TurnRowTags.TOOL)

        openLine("login.ts", substring = false)
        waitFor(DiffTags.LINE, 6)
        capture("3-file-diff")
        rule.onAllNodesWithTag(DiffTags.OPEN_FILE, useUnmergedTree = true).onFirst().performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(DiffTags.HEADER, useUnmergedTree = true).fetchSemanticsNodes().size == 1 }
        capture("4-file-diff-one-file")
        device.pressBack()
        device.pressBack()
        waitFor(TurnRowTags.TOOL)

        openLine("create_issue")
        capture("5-mcp-fields")
        device.pressBack()
        waitFor(TurnRowTags.TOOL)

        openLine("1 of 3")
        capture("6-plan")
    }

    @Test fun workspaceChanges() {
        show()
        rule.runOnUiThread { navigate("changes") }
        waitFor(DiffTags.LINE, 4)
        capture("7-workspace-changes")
    }

    private companion object {
        const val AGENT = "fx-agent"
        const val WORKSPACE = "fx-workspace"

        const val MODE = """{"providerId":"fx","modelId":"fx/model","effort":"medium","serviceTier":null,"permissionMode":"workspace_write"}"""
        const val BOOTSTRAP = """{"agent":{"id":"$AGENT","workspaceId":"$WORKSPACE","status":"idle","title":"Fix the login loop","pendingQuestionId":null},"mode":$MODE,"draft":{"value":null,"updatedAt":null},"pending":[]}"""
        const val CONFIG = """{"config":{
            "defaults":{"providerId":"fx","modelId":"fx/model","permissionMode":"workspace_write"},
            "models":{"fx/model":{"name":"Fixture model","efforts":["medium"],"defaultEffort":"medium","serviceTiers":[]}},
            "providers":{"fx":{"name":"Fixture","type":"fixture","models":[{"id":"fx/model"}]}}
        }}"""

        val BASE = mapOf(
            "sources/auth/login.ts" to "import { login } from './session';\n\nexport function go(user) {\n  return legacyLogin(user);\n}\n",
            "sources/auth/session.ts" to "export function login(user) {\n  return { user };\n}\n",
        )
        val WORKING = mapOf(
            "sources/auth/login.ts" to "import { login } from './session';\n\nexport function go(user) {\n  const session = login(user);\n  return session;\n}\n",
            "sources/auth/session.ts" to "export function login(user) {\n  return { user, expires: Date.now() + 3600_000 };\n}\n",
            "notes.md" to "# Notes\n\nThe login loop came from the legacy cookie.\n",
        )

        const val GIT = """{"git":{
            "facts":{"branch":"fix/login-loop","detached":false,"ahead":1,"behind":0},
            "comparison":"ready","base":"origin/main",
            "changedFiles":3,"insertions":6,"deletions":2,"countsExact":true,"conflicted":false,
            "files":[
              {"path":"sources/auth/login.ts","status":"modified","staged":false,"unstaged":true,"binary":false,"insertions":2,"deletions":1},
              {"path":"sources/auth/session.ts","status":"modified","staged":false,"unstaged":true,"binary":false,"insertions":1,"deletions":1},
              {"path":"notes.md","status":"untracked","staged":false,"unstaged":true,"binary":false,"insertions":3,"deletions":0}
            ],
            "filesTruncated":false,"scannedAt":1755400000000}}"""

        val PAGE = """{"hasMore":false,"runs":[{"id":"r1","status":"completed","startedAt":1,"messages":[
            {"id":"m1","role":"user","createdAt":1,"content":[{"type":"text","text":"Users get stuck in a login loop. Can you fix it?"}],"metadata":{}},
            {"id":"m2","role":"agent","createdAt":2,"content":[
                {"type":"text","text":"Looking at the auth code first."},
                {"type":"tool_call","id":"t1","name":"exploration","status":"completed","presentation":{"type":"exploration","operations":[
                    {"kind":"read","name":"login.ts","path":"sources/auth/login.ts"},
                    {"kind":"search","query":"legacyLogin","path":"sources"},
                    {"kind":"list","target":"sources/auth"}]}},
                {"type":"tool_call","id":"t2","name":"update_plan","status":"completed","arguments":{"explanation":"Small fix, then the tests.","plan":[
                    {"step":"Find where the loop starts","status":"completed"},
                    {"step":"Replace the legacy login","status":"in_progress"},
                    {"step":"Run the auth tests","status":"pending"}]}},
                {"type":"tool_call","id":"t3","name":"apply_patch","status":"completed","presentation":{"type":"file_diff","files":[
                    {"path":"sources/auth/login.ts","kind":"update","added":2,"deleted":1,"language":"typescript","hunks":[{"oldStart":3,"newStart":3,"lines":[
                        {"kind":"context","text":"export function go(user) {"},
                        {"kind":"delete","text":"  return legacyLogin(user);"},
                        {"kind":"add","text":"  const session = login(user);"},
                        {"kind":"add","text":"  return session;"},
                        {"kind":"context","text":"}"}]}]},
                    {"path":"notes.md","kind":"add","added":3,"deleted":0,"hunks":[{"oldStart":0,"newStart":1,"lines":[
                        {"kind":"add","text":"# Notes"},
                        {"kind":"add","text":""},
                        {"kind":"add","text":"The login loop came from the legacy cookie."}]}]}]}},
                {"type":"tool_call","id":"t4","name":"exec_command","status":"completed","elevated":true,
                    "review":{"outcome":"allowed","reason":"The person asked for the tests to run.","risk":"low","userAuthorization":"high"},
                    "presentation":{"type":"exec_command","command":"pnpm test sources/auth","output":"> vitest run sources/auth\n\n ✓ login.test.ts (6 tests) 41ms\n ✓ session.test.ts (3 tests) 12ms\n\n Test Files  2 passed (2)\n      Tests  9 passed (9)"}},
                {"type":"tool_call","id":"t5","name":"web_search","status":"completed","presentation":{"type":"search","target":"web","query":"cookie SameSite login redirect loop","sources":[
                    {"title":"SameSite cookies explained","url":"https://web.dev/articles/samesite-cookies-explained"}]}},
                {"type":"tool_call","id":"t6","name":"mcp__linear__create_issue","status":"completed",
                    "arguments":{"title":"Login loops after cookie change","team":"WEB","labels":["bug","auth"],"description":"Users bounce between /login and /home.\nFixed in fix/login-loop."},
                    "result":{"content":[{"type":"text","text":"{\"id\":\"WEB-42\",\"url\":\"https://linear.app/fixture/issue/WEB-42\",\"state\":\"Todo\"}"}]}},
                {"type":"text","text":"Fixed: the login now keeps its session instead of calling the legacy path, and the auth tests pass."}
            ],"metadata":{}}
        ]}]}"""
    }
}
