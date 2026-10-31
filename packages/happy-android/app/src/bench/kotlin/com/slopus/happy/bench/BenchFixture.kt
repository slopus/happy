package com.slopus.happy.bench

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.slopus.happy.HappyApplication
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import kotlin.concurrent.thread

/**
 * The bench build's account (research/cold-start.md): one agent connection,
 * "Bench Mac", open, with a kept home the size of Steve's, so a cold
 * start draws a home from disk as Steve's phone does. Its agent is at an
 * address nothing answers, so home stays the kept one.
 *
 * `am broadcast -f 0x20 -n com.slopus.happy.bench/com.slopus.happy.bench.BenchFixture -a com.slopus.happy.bench.SEED`
 * answers 1 once it is written (the benchmark's setup sends it, then kills the process, so the
 * next start reads what was written).
 */
class BenchFixture : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val app = context.applicationContext as HappyApplication
        val done = goAsync()
        thread(name = "bench-fixture") {
            try {
                seed(app)
                done.resultCode = 1
            } finally {
                done.finish()
            }
        }
    }

    private fun seed(app: HappyApplication) {
        ExpoSecureStore(
            prefs = app.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE),
            keys = AndroidKeyStoreKeys(),
            keychainService = AgentConnections.KEYCHAIN_SERVICE,
        ).setItem(ID, Json.encodeToString(AgentConnectionCredentials.serializer(), AgentConnectionCredentials("100.64.0.9", 7700, "bench-device", "bench-token")))
        app.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", Json.encodeToString(listOf(AgentConnection(id = ID, name = "Bench Mac", addedAt = 1L))))
            .commit()
        val catalog = AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), bootstrap()))
        File(app.noBackupFilesDir, "agent-connections").apply { mkdirs() }.resolve("$ID.json")
            .writeText(AgentClient.json.encodeToString(AgentCatalog.serializer(), catalog))
        runBlocking { app.graphReady.await() }.accountStore.select(ID)
    }

    /**
     * As big as Steve's (on 2026-10-31: 18 bots, 46 tasks, 24 projects, 53
     * workspaces, 167 agents, 350 KB kept), with the fields an agent sends.
     */
    private fun bootstrap(): JsonObject {
        val bots = (0 until 18).map { i ->
            val name = BOTS.getOrElse(i) { "Bot $i" }
            owner("bot$i", name) {
                put("orderKey", "%03d".format(i)); if (i == 0) put("role", "chief_of_staff")
                put("agent", agent("bot$i-agent", title = name))
            }
        }
        val tasks = (0 until 46).map { i ->
            owner("task$i", TITLES[i % TITLES.size] + if (i >= TITLES.size) " ${i / TITLES.size + 1}" else "") {
                put("ownerUserId", "bench-user"); put("folderName", "task-$i"); put("canArchive", true)
                // A third of them have handed work to subtasks of their own.
                val subtasks = if (i % 3 == 0) (0 until 3).map { s -> agent("task$i-sub$s", title = "Subtask $s", parent = "task$i-agent") } else emptyList()
                put("agent", agent("task$i-agent", title = null, working = i % 7 == 0, unread = i % 5 == 1, subtasks = subtasks))
            }
        }
        val projects = (0 until 24).map { i ->
            owner("project$i", "project-$i") {
                put("orderKey", "%03d".format(i)); project()
                put("agents", JsonArray(if (i % 2 == 0) listOf(agent("project$i-agent", title = "Work in project $i")) else emptyList()))
            }
        }
        val workspaces = (0 until 53).map { i ->
            owner("workspace$i", "worktree-$i") {
                put("projectId", "project${i % 24}"); put("parentId", "project${i % 24}"); put("kind", "worktree"); project()
                put("agents", JsonArray(if (i % 5 < 3) listOf(agent("workspace$i-agent", title = "Worktree task $i")) else emptyList()))
            }
        }
        return buildJsonObject {
            put("projects", JsonArray(projects)); put("workspaces", JsonArray(workspaces))
            put("bots", JsonArray(bots)); put("tasks", JsonArray(tasks))
            put("taskMemberships", JsonArray((0 until 27).map { i -> buildJsonObject { put("taskId", "task$i"); put("orderKey", "%03d".format(i)) } }))
            put("surfaces", JsonArray(emptyList()))
            put("profile", buildJsonObject { put("userId", "bench-user") })
            put("cursor", "01a193eb-39e7-7089-988a-ff53bb9db9d2")
        }
    }

    private fun owner(id: String, name: String, fields: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = buildJsonObject {
        put("id", id); put("name", name); put("nameSource", "user"); put("status", "active"); put("archivedAt", JsonNull)
        put("version", VERSION); put("createdAt", 1761900000000L); put("updatedAt", 1761900000000L)
        put("compute", buildJsonObject { put("kind", "local"); put("hostId", "host-0123456789abcdef") })
        fields()
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.project() {
        put("initialization", buildJsonObject { put("status", "ready"); put("error", JsonNull) })
        put("git", buildJsonObject { put("root", "/Users/bench/Developer/project"); put("branch", "main"); put("remote", "git@github.com:bench/project.git") })
        put("defaultBranch", "main"); put("worktreeSupport", "supported")
        put("settings", buildJsonObject { put("model", "default"); put("permissionMode", "default"); put("effort", "high") })
    }

    private fun agent(id: String, title: String?, working: Boolean = false, unread: Boolean = false, parent: String? = null, subtasks: List<JsonObject> = emptyList()) = buildJsonObject {
        put("id", id); put("workspaceId", "w$id"); put("version", VERSION); put("status", if (working) "running" else "idle")
        put("parentAgentId", parent); put("subtask", parent != null); put("subtaskOrderKey", JsonNull); put("userVisible", true)
        put("managedByAnotherAgent", false); put("canSendMessages", true); put("statusLine", JsonNull)
        put("title", title); put("titleStatus", if (title == null) "idle" else "ready"); put("pendingQuestionId", JsonNull)
        put("unread", if (unread) buildJsonObject { put("reason", "turn_finished"); put("since", 5L) } else JsonNull)
        put("wait", JsonNull); put("retrying", JsonNull); put("lastActivityAt", 1761900000000L)
        put("subagents", JsonArray(listOf(buildJsonObject { put("id", "sa-$id") })))
        put("processes", JsonArray(emptyList())); put("lastCursor", "01a193eb-39e7-7089-988a-ff53bb9db9d2")
        put("subtasks", JsonArray(subtasks)); put("orderKey", JsonNull); put("archivedAt", JsonNull)
        put("createdAt", 1761900000000L); put("updatedAt", 1761900000000L)
    }

    companion object {
        const val ACTION = "com.slopus.happy.bench.SEED"
        const val ID = "agent-connection-bench"
        private const val VERSION = "01a193eb-39e7-7089-988a-ff53bb9db9d2"
        private val BOTS = listOf("Chief of Staff", "Character Gen", "Release Notes")

        private val TITLES = listOf(
            "Build and Install Happy-Android to Galaxy", "Android cold start", "Telegram chat list research",
            "Android attachment menu", "Happy iOS App Subtask", "Everything on UltraList", "Agent media in chat",
            "Media streaming and offline", "iOS chat glass header", "New Task", "Build Mac App", "Release notes for 1.8",
        )
    }
}
