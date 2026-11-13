package com.slopus.happy.ui.plugins

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.plugins.Installability
import com.slopus.happy.plugins.InstallationStatus
import com.slopus.happy.plugins.Plugin
import com.slopus.happy.plugins.PluginInstallation
import com.slopus.happy.plugins.PluginTool
import com.slopus.happy.plugins.PluginsSnapshot
import com.slopus.happy.plugins.PluginsState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The plugins list and one plugin's page: what each groups and says, and their sizes. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class PluginScreensTest {
    @get:Rule val rule = createComposeRule()

    private fun plugin(key: String, name: String, description: String = "", tools: List<PluginTool> = emptyList()) =
        Plugin(key, key, name, description, "1.2.0", null, tools, authRequired = true, authMethods = emptyList(), installability = Installability.Installable, multiInstance = true)

    private fun installation(id: String, key: String, name: String, status: InstallationStatus, ordinal: Int = 1, label: String? = null, available: Boolean = true) =
        PluginInstallation(id, key, name, ordinal, label, status, null, null, available)

    private val snapshot = PluginsSnapshot(
        plugins = listOf(
            plugin("github", "GitHub", "Repositories and pull requests.", listOf(PluginTool("list_repos", "Lists repositories."))),
            plugin("linear", "Linear", "Issues and projects."),
        ),
        installations = listOf(
            installation("i1", "github", "GitHub", InstallationStatus.Active),
            installation("i2", "github", "GitHub", InstallationStatus.NeedsSetup, ordinal = 2, label = "Acme"),
            installation("i3", "jira", "jira", InstallationStatus.Active, available = false),
        ),
        canManage = false,
    )

    @Test
    fun theListShowsInstalledThenAvailable() {
        val opened = mutableListOf<String>()
        rule.setHappyContent { PluginsScreen(PluginsState.Loaded(snapshot), onOpen = { opened += it }, onRetry = {}, onBack = {}) }
        rule.onNodeWithText("INSTALLED").assertIsDisplayed()
        rule.onNodeWithText("GitHub").assertIsDisplayed()
        rule.onNodeWithText("GitHub · Acme").assertIsDisplayed()
        rule.onNodeWithText("Ready").assertIsDisplayed()
        rule.onNodeWithText("Needs setup").assertIsDisplayed()
        rule.onNodeWithText("Unavailable").assertIsDisplayed()
        rule.onNodeWithText("AVAILABLE").assertIsDisplayed()
        // GitHub is installed: only Linear is still on offer.
        rule.onNodeWithText("Issues and projects.").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithText("Repositories and pull requests.").fetchSemanticsNodes().size)
        rule.onNodeWithText("Only people whose role can manage plugins can install and set them up.").assertIsDisplayed()
        rule.node(PluginsTags.available("linear")).performClick()
        rule.node(PluginsTags.installation("i2")).performClick()
        assertEquals(listOf("linear", "github"), opened)
        assertDp("a row: its 24 title and 20 state between 16 above and below", 76, rule.node(PluginsTags.installation("i1")).bounds.let { it.bottom - it.top })
    }

    @Test
    fun aFailedReadOffersRetryAndAnEmptyServerSaysSo() {
        var retries = 0
        rule.setHappyContent { PluginsScreen(PluginsState.Failed, onOpen = {}, onRetry = { retries++ }, onBack = {}) }
        rule.node(PluginsTags.RETRY).performClick()
        assertEquals(1, retries)
    }

    @Test
    fun anEmptyServerSaysSo() {
        rule.setHappyContent { PluginsScreen(PluginsState.Loaded(PluginsSnapshot(emptyList(), emptyList(), true)), onOpen = {}, onRetry = {}, onBack = {}) }
        rule.onNodeWithText("This server offers no plugins yet.").assertIsDisplayed()
    }

    @Test
    fun aPluginPageShowsItsInstallationsAndTools() {
        rule.setHappyContent { PluginScreen(PluginsState.Loaded(snapshot), "github", onBack = {}, onRetry = {}) }
        rule.onNodeWithText("Version 1.2.0\nRepositories and pull requests.").assertIsDisplayed()
        rule.onNodeWithText("GitHub · Acme").assertIsDisplayed()
        rule.onNodeWithText("TOOLS").assertIsDisplayed()
        rule.onNodeWithText("list_repos").assertIsDisplayed()
        val hero = rule.node(PluginsTags.HERO).bounds
        assertDp("the picture 8 under where the list begins, 24 under the glass bar", 32, hero.top - rule.node(com.slopus.happy.ui.components.HeaderTags.BAR).bounds.bottom)
    }

    @Test
    fun aPluginTheServerStoppedOfferingSaysSo() {
        rule.setHappyContent { PluginScreen(PluginsState.Loaded(snapshot), "jira", onBack = {}, onRetry = {}) }
        rule.onNodeWithText("This server no longer offers this plugin.").assertIsDisplayed()
        rule.onNodeWithText("Unavailable").assertIsDisplayed()
    }

    @Test
    fun anUnknownPluginIsNotOffered() {
        rule.setHappyContent { PluginScreen(PluginsState.Loaded(snapshot), "nope", onBack = {}, onRetry = {}) }
        rule.onNodeWithText("This server doesn't offer this plugin.").assertIsDisplayed()
    }

    private val token = com.slopus.happy.plugins.PluginAuthMethod.Fields(
        "token", "Personal access token",
        listOf(com.slopus.happy.plugins.PluginField("token", "Token", "Starts with ghp_.", required = true, secret = true, multiline = false)),
    )
    private val app = com.slopus.happy.plugins.PluginAuthMethod.OAuth("install", "GitHub App", listOf("repo"))

    private fun managed(status: InstallationStatus) = PluginsSnapshot(
        plugins = listOf(plugin("github", "GitHub").copy(authMethods = listOf(app, token))),
        installations = listOf(installation("i1", "github", "GitHub", status).copy(authMethod = "token".takeIf { status == InstallationStatus.Active })),
        canManage = true,
    )

    @Test
    fun anInstallationNeedingSetupOffersEachMethodAndSavesTheFields() {
        val saved = mutableListOf<Map<String, String>>()
        var connected = 0
        val acts = PluginActs()
        rule.setHappyContent {
            PluginInstallationScreen(
                PluginsState.Loaded(managed(InstallationStatus.NeedsSetup)), "i1", emptyList(), acts, signingIn = false,
                onConnect = { _, _ -> connected++ }, onConfigure = { _, _, values -> saved += values }, onDisconnect = { _, _ -> }, onRemove = {}, onBack = {},
            )
        }
        rule.onNodeWithText("Continue with GitHub App").performClick()
        assertEquals(1, connected)
        // Two methods: the fields open on a tap, and Save waits for what is required.
        rule.node(PluginActionTags.method("token")).performClick()
        rule.node(PluginActionTags.SAVE).assertIsNotEnabled()
        rule.node(PluginActionTags.field("token")).performTextInput(" ghp_abc ")
        rule.node(PluginActionTags.SAVE).performClick()
        assertEquals(listOf(mapOf("token" to "ghp_abc")), saved)
        assertEquals(0, rule.onAllNodesWithText("SIGNED IN").fetchSemanticsNodes().size)
    }

    @Test
    fun aRefusedFieldSaysWhyUnderIt() {
        val acts = PluginActs().apply { refusal = com.slopus.happy.plugins.PluginRefusal.Fields(mapOf("token" to "GitHub didn't accept this token.")) }
        val single = managed(InstallationStatus.NeedsSetup).let { it.copy(plugins = it.plugins.map { p -> p.copy(authMethods = listOf(token)) }) }
        rule.setHappyContent {
            PluginInstallationScreen(PluginsState.Loaded(single), "i1", emptyList(), acts, false, { _, _ -> }, { _, _, _ -> }, { _, _ -> }, {}, {})
        }
        // The only method is open at once.
        rule.node(PluginActionTags.fieldError("token")).assertTextEquals("GitHub didn't accept this token.")
    }

    @Test
    fun anActiveInstallationListsItsAccountsAndConfirmsBeforeDisconnecting() {
        val disconnected = mutableListOf<String?>()
        var removed = 0
        rule.setHappyContent {
            PluginInstallationScreen(
                PluginsState.Loaded(managed(InstallationStatus.Active)), "i1", listOf(com.slopus.happy.plugins.PluginConnection("s1", "octocat", "Personal access token")), PluginActs(), false,
                { _, _ -> }, { _, _, _ -> }, { _, connection -> disconnected += connection?.id }, { removed++ }, {},
            )
        }
        rule.onNodeWithText("SIGNED IN").assertIsDisplayed()
        // The row under the bar says what it is, not the bar's title again: the version and the account.
        rule.onNodeWithText("Version 1.2.0 · octocat", useUnmergedTree = true).assertIsDisplayed()
        rule.node(PluginActionTags.connection("s1")).performClick()
        rule.onNodeWithText("Disconnect octocat?").assertIsDisplayed()
        rule.onAllNodesWithText("Disconnect").fetchSemanticsNodes().size.let { assertEquals("the row and the alert's button", 2, it) }
        rule.onAllNodesWithText("Disconnect")[1].performClick()
        assertEquals(listOf<String?>("s1"), disconnected)
        rule.node(PluginActionTags.REMOVE).performClick()
        rule.onNodeWithText("Remove GitHub?").assertIsDisplayed()
        rule.onAllNodesWithText("Remove")[1].performClick()
        assertEquals(1, removed)
    }

    @Test
    fun aMemberReadsAnInstallationWithoutChangingIt() {
        val read = managed(InstallationStatus.NeedsSetup).copy(canManage = false)
        rule.setHappyContent { PluginInstallationScreen(PluginsState.Loaded(read), "i1", emptyList(), PluginActs(), false, { _, _ -> }, { _, _, _ -> }, { _, _ -> }, {}, {}) }
        rule.onNodeWithText("Needs setup").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithText("SET UP").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithText("Remove").fetchSemanticsNodes().size)
    }

    @Test
    fun aManagerInstalls() {
        var installs = 0
        val snapshot = PluginsSnapshot(listOf(plugin("linear", "Linear")), emptyList(), canManage = true)
        rule.setHappyContent {
            PluginScreen(PluginsState.Loaded(snapshot), "linear", onBack = {}, onRetry = {}, actions = { p, s -> PluginInstallActions(p, s, PluginActs()) { installs++ } })
        }
        rule.onNodeWithText("Install").assertIsDisplayed()
        rule.node(PluginActionTags.INSTALL).performClick()
        assertEquals(1, installs)
    }
}
