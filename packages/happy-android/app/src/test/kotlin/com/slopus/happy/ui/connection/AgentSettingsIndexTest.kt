package com.slopus.happy.ui.connection

import androidx.compose.ui.unit.dp
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.StartRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ProvideRowReveal
import com.slopus.happy.ui.conversation.ChiefOfStaffRoute
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsFixtures
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.settings.SettingsTags
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Home's search jumps into an agent connection's settings as iOS's does
 * (`SettingsIndex.computer`, `SettingsViewController.open(reveal:)`): every
 * row it finds is on its page under the same id and title; opened, the page
 * is pushed with the row to reveal (Appearance's over settings, an ask
 * straight to the Chief of Staff); and the page scrolls the row to the
 * middle of what shows.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentSettingsIndexTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @androidx.compose.runtime.Composable
    private fun settingsPage() {
        AgentConnectionSettingsScreen(
            profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
            accounts = SettingsFixtures.accounts,
            actions = AgentSettingsActions(onDataStorage = {}, onSharing = {}, onAgents = {}),
            about = AboutInfo("1.8.0 (412)"),
        )
    }

    @Test
    fun everyRowSearchFindsIsOnItsPageByTheSameTitle() {
        var index = emptyList<AgentSettingsRow>()
        rule.setHappyContent {
            index = agentSettingsIndex()
            settingsPage()
        }
        rule.waitForIdle()
        assertEquals(
            listOf(
                AgentSettingsTags.PROFILE, AgentSettingsTags.ASK_NAME, AgentSettingsTags.ASK_AVATAR, AgentVoiceTags.SUPPORT, AgentSettingsTags.APPEARANCE,
                AgentPagesTags.HIDE_PROJECTS_ROW, AgentVoiceTags.ROW, AgentAgentsTags.ROW, DataStorageTags.ROW, AgentSharingTags.ROW, SettingsTags.SUPPORT, SettingsTags.MANAGE_SUBSCRIPTIONS, com.slopus.happy.ui.settings.SettingsPageTags.ADD_AGENT,
                SettingsTags.WHATS_NEW, SettingsTags.GITHUB, SettingsTags.REPORT_ISSUE, SettingsTags.PRIVACY, SettingsTags.TERMS, SettingsTags.VERSION,
            ),
            index.map { it.id },
        )
        for (row in index.filter { it.place == AgentSettingsPlace.Settings }) {
            rule.onNode(hasTestTag(row.id) and hasAnyDescendant(hasText(row.title)), useUnmergedTree = true).assertExists()
        }
        assertTrue(index.filter { it.place == AgentSettingsPlace.Ask }.all { !it.ask.isNullOrEmpty() })
    }

    @Test
    fun appearancesRowsAreOnItsPageByTheSameTitle() {
        var index = emptyList<AgentSettingsRow>()
        rule.setHappyContent {
            index = agentSettingsIndex()
            AgentAppearanceScreen(ThemePreference.Adaptive, {}, false, {}, {})
        }
        rule.waitForIdle()
        val rows = index.filter { it.place == AgentSettingsPlace.Appearance }
        assertTrue(rows.isNotEmpty())
        for (row in rows) rule.onNode(hasTestTag(row.id) and hasAnyDescendant(hasText(row.title)), useUnmergedTree = true).assertExists()
    }

    @Test
    fun aRevealedRowIsScrolledIntoView() {
        var reveal by mutableStateOf<String?>(null)
        rule.setHappyContent {
            key(reveal) { ProvideRowReveal(reveal) { settingsPage() } }
        }
        rule.waitForIdle()
        // Below the 891 window until it is asked for.
        assertTrue(rule.node(SettingsTags.TERMS).bounds.top > 891.dp)
        reveal = SettingsTags.TERMS
        rule.waitForIdle()
        val row = rule.node(SettingsTags.TERMS).bounds
        // As near the middle of what shows under the 64 bar as the page's end allows.
        assertTrue("$row", row.top >= 64.dp && row.bottom <= 891.dp)
        assertTrue("$row", (row.top + row.bottom) / 2 >= (64 + (891 - 64) / 2f).dp)
    }

    private lateinit var nav: NavHostController

    private fun host() {
        rule.setContent {
            nav = rememberNavController()
            NavHost(nav, startDestination = StartRoute) {
                composable<StartRoute> { Text("home") }
                composable<SettingsRoute> { Text("settings") }
                composable<AgentAppearanceRoute> { Text("appearance") }
                composable<ChiefOfStaffRoute> { Text("chief") }
            }
        }
    }

    private fun stack(): List<String> = nav.currentBackStack.value.mapNotNull { entry ->
        when {
            entry.destination.hasRoute<StartRoute>() -> "home"
            entry.destination.hasRoute<SettingsRoute>() -> entry.toRoute<SettingsRoute>().let { "settings:${it.reveal}" }
            entry.destination.hasRoute<AgentAppearanceRoute>() -> entry.toRoute<AgentAppearanceRoute>().let { "appearance:${it.connectionId}:${it.reveal}" }
            entry.destination.hasRoute<ChiefOfStaffRoute>() -> entry.toRoute<ChiefOfStaffRoute>().let { "chief:${it.connectionId}:${it.prefix}" }
            else -> null
        }
    }

    @Test
    fun aRowOpensItsPageToRevealIt() {
        host()
        rule.runOnIdle { nav.openAgentSettingsRow("c1", AgentSettingsRow(SettingsTags.PRIVACY, "Privacy Policy", com.slopus.happy.ui.components.Ionicon.Add, AgentSettingsPlace.Settings)) }
        rule.runOnIdle { assertEquals(listOf("home", "settings:${SettingsTags.PRIVACY}"), stack()) }
    }

    @Test
    fun appearancesRowOpensOverSettings() {
        host()
        rule.runOnIdle {
            nav.openAgentSettingsRow("c1", AgentSettingsRow(AgentPagesTags.HIDE_PROJECTS_ROW, "Hide projects", com.slopus.happy.ui.components.Ionicon.Add, AgentSettingsPlace.Appearance))
        }
        rule.runOnIdle { assertEquals(listOf("home", "settings:null", "appearance:c1:${AgentPagesTags.HIDE_PROJECTS_ROW}"), stack()) }
    }

    @Test
    fun anAskOpensTheChiefOfStaffWithItsWords() {
        host()
        rule.runOnIdle {
            nav.openAgentSettingsRow("c1", AgentSettingsRow(AgentSettingsTags.ASK_NAME, "Edit name", com.slopus.happy.ui.components.Ionicon.Add, AgentSettingsPlace.Ask, "Change your name to "))
        }
        rule.runOnIdle { assertEquals(listOf("home", "chief:c1:Change your name to "), stack()) }
    }
}
