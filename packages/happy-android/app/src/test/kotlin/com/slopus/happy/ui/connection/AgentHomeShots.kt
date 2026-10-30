package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.Wire
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Fixture renders for review, written only when HAPPY_SHOTS_DIR is set. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentHomeShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)
    private val actions = AgentHomeActions({}, {}, {}, {}, {}, {})
    private val settingsActions = AgentSettingsActions({}, {}, {}, {}, {}, {})
    private val accounts = AccountMenu(listOf(
        AccountMenuEntry("0123456789abcdef", "Steve"),
        AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true),
        AccountMenuEntry("agent-connection-2", "Old Mac", agent = true, attention = true),
    ))
    private val feed get() = AgentFeed.derive(AgentHomeLayoutTest.catalog(AgentHomeLayoutTest.sample))
    private val empty get() = AgentFeed.derive(AgentHomeLayoutTest.catalog(Wire.bootstrap()))

    private fun save(name: String) {
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun show(feed: AgentFeed, status: AgentLinkStatus = AgentLinkStatus.Connected, dark: Boolean = false) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark) { AgentHomeScreen("Studio", feed, status, accounts, actions, now = 1_755_400_000_000L) }
    }

    @Test fun listLight() { show(feed); save("home-list-light") }
    @Test fun listDark() { show(feed, dark = true); save("home-list-dark") }
    @Test fun subtasksOpen() { show(feed); rule.node(AgentHomeTags.toggle("ab1")).performClick(); save("home-subtasks-open") }
    @Test fun accountMenu() { show(feed); rule.node(AccountMenuTags.BUTTON).performClick(); save("home-account-menu") }
    @Test fun searchEmptyQuery() { show(feed); rule.node(AgentHomeTags.SEARCH).performClick(); save("search-open-empty") }
    @Test fun searchResults() { show(feed); rule.node(AgentHomeTags.SEARCH).performClick(); rule.node(AgentSearchTags.FIELD).performTextInput("re"); save("search-results") }
    @Test fun searchNone() { show(feed); rule.node(AgentHomeTags.SEARCH).performClick(); rule.node(AgentSearchTags.FIELD).performTextInput("zzzz"); save("search-no-results") }
    @Test fun connecting() { show(AgentFeed.Empty, AgentLinkStatus.Connecting); save("state-connecting") }
    @Test fun offline() { show(AgentFeed.Empty, AgentLinkStatus.Offline); save("state-offline-no-cache") }
    @Test fun offlineCached() { show(feed, AgentLinkStatus.Offline); save("state-offline-cached") }
    @Test fun revoked() { show(feed, AgentLinkStatus.Revoked); save("state-revoked") }
    @Test fun emptyLight() { show(empty); save("state-empty-light") }
    @Test fun emptyDark() { show(empty, dark = true); save("state-empty-dark") }

    @Test fun settings() {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent { AgentConnectionSettingsScreen("Studio", "agent-connection-1", null, AgentLinkStatus.Connected, accounts, settingsActions) }
        save("settings")
    }

    @Test fun settingsDark() {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark = true) { AgentConnectionSettingsScreen("Studio", "agent-connection-1", null, AgentLinkStatus.Connected, accounts, settingsActions) }
        save("settings-dark")
    }
}
