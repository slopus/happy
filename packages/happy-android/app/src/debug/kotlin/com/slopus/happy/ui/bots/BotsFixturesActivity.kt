package com.slopus.happy.ui.bots

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.BotEditForm
import com.slopus.happy.agent.WireDesktopBootstrap
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.conversation.AgentKind
import com.slopus.happy.ui.conversation.AgentPageActions
import com.slopus.happy.ui.conversation.AgentPageScreen
import com.slopus.happy.ui.conversation.AgentPageState
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Debug builds only: Happy Cloud's shared and personal bots over an
 * in-memory server. `--es bots.scene owner` (default) is an owner's home,
 * the shared bot among the places; `member` a member's, personal bots
 * alone; `page` a personal bot's agent page with its settings row; `edit`
 * its settings, saving in memory. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.bots.BotsFixturesActivity --es bots.scene member`.
 */
class BotsFixturesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val scene = intent.getStringExtra("bots.scene") ?: "owner"
        setContent {
            HappyTheme {
                when (scene) {
                    "member", "owner" -> {
                        val feed = remember { AgentFeed.derive(catalog(owner = scene == "owner"), feedUnread = 3) }
                        AgentHomeScreen("Acme", feed, AgentLinkStatus.Connected, ACCOUNTS, AgentHomeActions({}, {}, {}, {}, {}, {}))
                    }
                    "page" -> AgentPageScreen(
                        AgentPageState(
                            agentId = "a-research",
                            name = "Researcher",
                            kind = AgentKind.Bot,
                            row = AgentFeed.derive(catalog(owner = false)).conversations.first { it.agentId == "a-research" },
                            reading = false,
                            botSettings = true,
                        ),
                        AgentPageActions(onBack = ::finish),
                    )
                    else -> {
                        val scope = rememberCoroutineScope()
                        var state by remember { mutableStateOf(BotSettingsState("research", BotEditForm.of(RESEARCHER))) }
                        BotSettingsScreen(
                            state,
                            photo = null,
                            onEdit = { change -> state = state.copy(form = state.form?.let(change)) },
                            onSave = {
                                state = state.copy(saving = true)
                                scope.launch {
                                    delay(600)
                                    val form = state.form!!
                                    state = state.copy(saving = false, form = BotEditForm(form.name.trim(), form.instructions, form.name.trim(), form.instructions))
                                }
                            },
                            onChangePhoto = {},
                            onRemovePhoto = {},
                            onBack = ::finish,
                        )
                    }
                }
            }
        }
    }

    private companion object {
        val ACCOUNTS = AccountMenu(listOf(AccountMenuEntry("cloud", "Acme", agent = true, active = true)))

        fun agent(id: String, title: String? = null, unread: Boolean = false) = buildJsonObject {
            put("id", id); put("workspaceId", "w-$id"); put("version", "01"); put("status", "idle")
            put("parentAgentId", JsonNull); put("subtask", false); put("userVisible", true); put("title", title)
            put("unread", if (unread) buildJsonObject { put("reason", "turn_finished"); put("since", 5L) } else JsonNull)
            put("subtasks", JsonArray(emptyList())); put("createdAt", 1L); put("updatedAt", 2L)
        }

        fun bot(id: String, name: String, kind: String, admin: Boolean, editable: Boolean, orderKey: String, unread: Boolean = false) = buildJsonObject {
            put("id", id); put("name", name); put("version", "01"); put("orderKey", orderKey); put("status", "active")
            put("kind", kind); put("isAdmin", admin); put("editable", editable)
            if (admin) put("systemKey", "chief_of_staff")
            put("agent", agent("a-$id", unread = unread))
        }

        val RESEARCHER = JsonObject(
            bot("research", "Researcher", "personal", admin = false, editable = true, orderKey = "2", unread = true) +
                ("instructions" to kotlinx.serialization.json.JsonPrimitive("Read the papers the team links in chat and summarise them in five bullets.\nCite every claim.")),
        )

        fun catalog(owner: Boolean): AgentCatalog {
            val bots = listOfNotNull(
                bot("chief", "Chief of Staff", "shared", admin = true, editable = false, orderKey = "1").takeIf { owner },
                RESEARCHER,
                bot("writer", "Release Notes", "personal", admin = false, editable = true, orderKey = "3"),
                bot("triage", "Triage", "personal", admin = false, editable = true, orderKey = "4"),
            )
            val task = buildJsonObject {
                put("id", "t1"); put("name", "Fix the login redirect"); put("version", "01"); put("status", "active")
                put("agent", agent("a-t1"))
            }
            val bootstrap = WireDesktopBootstrap(
                bots = bots,
                tasks = listOf(task),
                taskMemberships = listOf(buildJsonObject { put("taskId", "t1"); put("orderKey", "1") }),
            )
            return AgentCatalog().withBootstrap(bootstrap)
        }
    }
}
