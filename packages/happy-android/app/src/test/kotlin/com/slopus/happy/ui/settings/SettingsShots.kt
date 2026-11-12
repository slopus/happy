package com.slopus.happy.ui.settings

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import com.slopus.happy.ui.node
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentProfileState
import com.slopus.happy.agent.WireProfile
import com.slopus.happy.ui.connection.AgentAppearanceScreen
import com.slopus.happy.ui.connection.AgentConnectionSettingsScreen
import com.slopus.happy.ui.connection.AgentPerson
import com.slopus.happy.ui.connection.AgentProfileScreen
import com.slopus.happy.ui.connection.AgentSettingsActions
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Whole-page settings renders for review, written only when HAPPY_SHOTS_DIR is set. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h1600dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private fun shot(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark) { content() }
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private val happy: @Composable () -> Unit = {
        SettingsScreen(
            profile = SettingsFixtures.profile,
            about = AboutInfo("1.8.0 (412)", "Commit 2026-10-16 03:12 UTC / abc1234"),
            accounts = SettingsFixtures.accounts,
            accountActions = AccountsCardActions({}, {}),
            actions = HappySettingsActions(),
        )
    }

    private val agent: @Composable () -> Unit = {
        AgentConnectionSettingsScreen(
            SettingsProfile("agent-connection-1", "Studio", "Connected"),
            AccountMenu(listOf(
                AccountMenuEntry("0123456789abcdef", "Ada Lovelace"),
                AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true),
                AccountMenuEntry("agent-connection-2", "Old Mac", agent = true),
            )),
            AgentSettingsActions(onDataStorage = {}, onSharing = {}, onAgents = {}, onUsage = {}),
            AboutInfo("1.8.0 (412)"),
            person = AgentPerson("Steve"),
        )
    }

    /** A Happy Cloud server's: every group desktop's sidebar has that a phone does. */
    private val cloud: @Composable () -> Unit = {
        AgentConnectionSettingsScreen(
            SettingsProfile("agent-connection-1", "@acme", "Connected"),
            AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "@acme", agent = true, active = true))),
            AgentSettingsActions(onDataStorage = {}, onSharing = {}, onAgents = {}, onMembers = {}, onProviders = {}, onCompute = {}, onNotifications = {}, onUsage = {}),
            AboutInfo("1.8.0 (412)"),
            person = AgentPerson("Steve"),
        )
    }

    @Test fun cloudLight() = shot("settings-cloud", content = cloud)
    @Test fun happyLight() = shot("settings-happy", content = happy)
    @Test fun happyDark() = shot("settings-happy-dark", dark = true, content = happy)
    @Test fun agentLight() = shot("settings-agent", content = agent)
    @Test fun agentDark() = shot("settings-agent-dark", dark = true, content = agent)

    @Test fun account() = shot("settings-account") {
        AccountScreen(
            anonId = "3f2a9c1e-77b0-4d2e-9a51-0c6e8b4f1d23", publicId = "0123456789abcdef",
            analyticsOptOut = false, onAnalyticsOptOutChange = {}, onBack = {},
            displayName = "Ada Lovelace", username = "ada",
        )
    }

    @Test fun backup() = shot("settings-backup") {
        BackupScreen("ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z2345-67ABC-DEFGH", onBack = {})
    }

    @Test fun agentAppearance() = shot("settings-agent-appearance") {
        AgentAppearanceScreen(ThemePreference.Adaptive, {}, projectsHidden = true, onProjectsHidden = {}, onBack = {})
    }

    @Test fun agentProfile() = shot("settings-agent-profile") {
        AgentProfileScreen("seed", AgentProfileState(WireProfile(name = "Steve", version = "v1")), null, {}, {}, {}, {})
    }

    /** The picture's menu open over the agent's settings: the pencil badge, then the drop-down. */
    private fun agentEditMenu(dark: Boolean) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark) { agent() }
        rule.node(SettingsPageTags.PICTURE).performClick()
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "settings-agent-edit-menu${if (dark) "-dark" else ""}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun agentEditMenuLight() = agentEditMenu(false)
    @Test fun agentEditMenuDark() = agentEditMenu(true)
}
