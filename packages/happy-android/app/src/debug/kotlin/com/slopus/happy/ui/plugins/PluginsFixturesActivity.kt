package com.slopus.happy.ui.plugins

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.plugins.Installability
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.Plugin
import com.slopus.happy.plugins.PluginAuthMethod
import com.slopus.happy.plugins.PluginConnection
import com.slopus.happy.plugins.PluginField
import com.slopus.happy.plugins.PluginInstallation
import com.slopus.happy.plugins.PluginRefusal
import com.slopus.happy.plugins.PluginTool
import com.slopus.happy.plugins.PluginsBackend
import com.slopus.happy.plugins.PluginsException
import com.slopus.happy.plugins.PluginsSnapshot
import com.slopus.happy.plugins.PluginsSource
import com.slopus.happy.ui.RetainedNavHost
import com.slopus.happy.ui.backdrop
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connection.AgentHomeItem
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.page
import com.slopus.happy.ui.rememberNavMotion
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.Serializable

/**
 * Debug builds only: the real plugin pages over an in-memory Happy Cloud
 * server ([FakePlugins]), reached from a home card with the Plugins row
 * under Artifacts. Install, set up (GitHub's token takes `ghp_` and refuses
 * anything else), disconnect and remove all work against it. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.plugins.PluginsFixturesActivity`
 * (`--ez plugins.member true` for a member who may not manage plugins).
 */
class PluginsFixturesActivity : ComponentActivity() {
    @Serializable private data object FixtureHomeRoute

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val member = intent.getBooleanExtra("plugins.member", false)
        setContent {
            HappyTheme {
                val nav = rememberNavController()
                val scope = rememberCoroutineScope()
                val source = remember { PluginsSource(FakePlugins(canManage = !member), MutableSharedFlow<AgentEvent>(), scope) }
                RetainedNavHost(nav, FixtureHomeRoute, rememberNavMotion(), modifier = Modifier.backdrop(nav)) {
                    page<FixtureHomeRoute> {
                        Screen(header = { StackHeader("Acme", onBack = ::finish) }) {
                            AgentHomeList(
                                items = listOf(
                                    AgentHomeItem.Gap(AgentFeedSection.Places, first = true),
                                    AgentHomeItem.Row(AgentFeedRow.Artifacts, first = true, last = false),
                                    AgentHomeItem.Row(AgentFeedRow.Plugins, first = false, last = false),
                                    AgentHomeItem.Row(AgentFeedRow.Todos, first = false, last = true),
                                ),
                                state = rememberLazyListState(),
                                onOpen = {},
                                contentPadding = PaddingValues(),
                                onOpenPlugins = { nav.navigate(PluginsRoute("fixture")) },
                            )
                        }
                    }
                    pluginRoutes(nav) { PagePlugins(source, null) }
                }
            }
        }
    }
}

/** A Happy Cloud server's plugins in memory, answering after a short wait as a real one would. */
private class FakePlugins(private val canManage: Boolean) : PluginsBackend {
    private val github = Plugin(
        key = "github", id = "github", name = "GitHub", description = "Repositories, issues and pull requests for your agents.", version = "2.1.0", image = null,
        tools = listOf(PluginTool("list_repos", "Lists the repositories the installation can reach."), PluginTool("open_pull_request", "Opens a pull request from a branch.")),
        authRequired = true,
        authMethods = listOf(
            PluginAuthMethod.OAuth("install", "GitHub App", listOf("repo")),
            PluginAuthMethod.Fields("token", "Personal access token", listOf(PluginField("token", "Token", "A fine-grained token with read access to the repositories agents may use.", required = true, secret = true, multiline = false))),
        ),
        installability = Installability.Installable, multiInstance = true,
    )
    private val linear = Plugin(
        "linear", "linear", "Linear", "Issues, projects and cycles.", "1.0.3", null, listOf(PluginTool("search_issues", "Finds issues by text.")), authRequired = true,
        authMethods = listOf(PluginAuthMethod.Fields("key", "API key", listOf(PluginField("api_key", "API key", "Linear › Settings › API.", required = true, secret = true, multiline = false)))),
        installability = Installability.Installable, multiInstance = false,
    )
    private val weather = Plugin("weather", "weather", "Weather", "Forecasts for any city, no sign-in needed.", "0.4.0", null, emptyList(), authRequired = false, authMethods = emptyList(), installability = Installability.Installable, multiInstance = false)
    private val catalog = listOf(github, linear, weather)
    private val installations = mutableListOf(
        PluginInstallation("i1", "github", "GitHub", 1, null, InstallationStatus.Active, "token", null, true),
        PluginInstallation("i2", "github", "GitHub", 2, "Acme", InstallationStatus.MethodUnavailable, "install", null, true),
    )
    private var next = 3

    override suspend fun read(): PluginsSnapshot {
        delay(350)
        return PluginsSnapshot(catalog.sortedBy { it.name }, installations.toList(), canManage)
    }

    override suspend fun install(plugin: Plugin): String {
        delay(500)
        val id = "i${next++}"
        val ordinal = installations.count { it.pluginKey == plugin.key } + 1
        installations += PluginInstallation(id, plugin.key, plugin.name, ordinal, null, if (plugin.authRequired) InstallationStatus.NeedsSetup else InstallationStatus.Active, null, null, true)
        return id
    }

    override suspend fun remove(installationId: String) {
        delay(400)
        installations.removeAll { it.id == installationId }
    }

    override suspend fun configure(installationId: String, methodId: String, values: Map<String, String>) {
        delay(700)
        val token = values.values.firstOrNull().orEmpty()
        if (methodId == "token" && !token.startsWith("ghp_")) throw PluginsException(PluginRefusal.Fields(mapOf("token" to "GitHub didn't accept this token.")))
        update(installationId) { it.copy(status = InstallationStatus.Active, authMethod = methodId) }
    }

    override suspend fun connect(installationId: String, methodId: String): String {
        delay(300)
        return "https://github.com/apps/happy-engineering/installations/new"
    }

    override suspend fun disconnect(installationId: String, connectionId: String?) {
        delay(400)
        update(installationId) { it.copy(status = InstallationStatus.NeedsSetup, authMethod = null) }
    }

    override suspend fun connections(installationId: String): List<PluginConnection> =
        if (installations.firstOrNull { it.id == installationId }?.status == InstallationStatus.Active) listOf(PluginConnection("s1", "octocat", "Personal access token")) else emptyList()

    override fun changes(event: AgentEvent) = false

    private fun update(id: String, change: (PluginInstallation) -> PluginInstallation) {
        val at = installations.indexOfFirst { it.id == id }
        if (at < 0) throw PluginsException(PluginRefusal.NotFound)
        installations[at] = change(installations[at])
    }
}
