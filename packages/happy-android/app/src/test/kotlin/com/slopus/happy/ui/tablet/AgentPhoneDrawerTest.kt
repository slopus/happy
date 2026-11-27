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
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.connection.AgentDrawerItems
import com.slopus.happy.ui.connection.AgentDrawerTags
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsSelected
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.navigation.NavDestination.Companion.hasRoute
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
 * A Happy Agent account on a phone has the drawer (Steve): home's bar has
 * its button and search, not the account or Settings, which are the
 * drawer's; a pick is the stack's new root over home, whose back is the
 * drawer's button, and Home goes back to home alone.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentPhoneDrawerTest {
    @get:Rule val rule = createComposeRule()

    private lateinit var nav: NavHostController

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

    private fun stack(): List<String> = nav.currentBackStack.value.filter { it.destination !is NavGraph }.map { entry ->
        when {
            entry.destination.hasRoute<HomeRoute>() -> "home"
            entry.destination.hasRoute<SettingsRoute>() -> "settings"
            else -> entry.destination.route.orEmpty()
        }
    }

    @Test
    fun homesBarOpensTheDrawerWhichHoldsTheAccountAndSettings() {
        rule.setContent { HappyApp(graph, onNavigationReady = { nav = it }) }
        rule.waitUntilAtLeastOneExists(hasTestTag(AgentHomeTags.BAR), 10_000)
        rule.node(AgentHomeTags.SEARCH).assertExists()
        for (tag in listOf(AccountMenuTags.BUTTON, AgentHomeTags.SETTINGS)) {
            assertEquals(tag, 0, rule.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().size)
        }
        rule.node(MainPanelTags.DRAWER).performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(AgentDrawerTags.HEADER), 5_000)
        rule.node(AgentDrawerTags.item(AgentDrawerItems.HOME)).assertIsSelected()
        rule.node(AgentDrawerTags.SETTINGS).performClick()
        rule.waitForIdle()
        assertEquals(listOf("home", "settings"), stack())
        // Settings is the drawer's root: its back is the drawer's button.
        rule.waitUntil(5_000) { rule.onAllNodes(hasTestTag(MainPanelTags.DRAWER) and com.slopus.happy.ui.isOnActivePage, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNode(hasTestTag(MainPanelTags.DRAWER) and com.slopus.happy.ui.isOnActivePage, useUnmergedTree = true).performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(AgentDrawerTags.SETTINGS), 5_000)
        rule.node(AgentDrawerTags.SETTINGS).assertIsSelected()
        rule.node(AgentDrawerTags.item(AgentDrawerItems.HOME)).performClick()
        rule.waitForIdle()
        assertEquals(listOf("home"), stack())
    }
}
