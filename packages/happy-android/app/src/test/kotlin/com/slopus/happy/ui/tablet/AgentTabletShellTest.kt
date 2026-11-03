package com.slopus.happy.ui.tablet

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.node
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * A Happy Agent account splits the tablet as a Happy CLI one does (iOS
 * 366a43cd0): its home is the sidebar, with the account and its name in
 * the bar and settings at the foot, beside the empty main panel's owl.
 * The computer here never answers, so home shows its offline page and
 * there is nothing to start.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentTabletShellTest {
    @get:Rule val rule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val agent = "agent-connection-1"
    private lateinit var graph: AppGraph

    @Before
    fun setUp() {
        val names = listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, ServerConfig.PREFS_NAME, AgentConnections.REGISTRY_PREFS, AgentConnections.SECRETS_PREFS)
        for (name in names) context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        File(context.filesDir, "mmkv").deleteRecursively()
        // One agent connection, paired before, at an address nothing answers on.
        ExpoSecureStore(context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE), keys, keychainService = AgentConnections.KEYCHAIN_SERVICE)
            .setItem(agent, Json.encodeToString(AgentConnectionCredentials.serializer(), AgentConnectionCredentials("127.0.0.1", 9, "dv1", "token")))
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"$agent","name":"Studio","addedAt":1}]""").commit()
        graph = AppGraph(context, "android/test", "http://127.0.0.1:9", keys, databaseName = null).also { it.setForeground(true) }
        graph.open(agent)
    }

    @After
    fun tearDown() = Unit

    @Test
    fun agentHomeIsTheSidebar() {
        rule.setContent { HappyApp(graph) }
        rule.waitUntilAtLeastOneExists(hasTestTag(AgentHomeTags.BAR), 10_000)
        val sidebar = rule.node(SidebarTags.SIDEBAR).bounds
        assertBox("sidebar", sidebar, 0.dp, 0.dp, 360.dp, sidebar.bottom)
        rule.node(MainPanelTags.PLACEHOLDER).assertExists()
        assertTrue("home's bar is the sidebar's", rule.node(AgentHomeTags.BAR).bounds.right <= sidebar.right)
        assertTrue("so is the account switcher", rule.node(AccountMenuTags.BUTTON).bounds.right <= sidebar.right)
        rule.node(SidebarTags.SETTINGS).assertExists()
        for (tag in listOf(AgentHomeTags.SEARCH, AgentHomeTags.SETTINGS, AgentHomeTags.COMPOSE, SidebarTags.COMPOSE)) {
            assertEquals(tag, 0, rule.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().size)
        }
    }
}
