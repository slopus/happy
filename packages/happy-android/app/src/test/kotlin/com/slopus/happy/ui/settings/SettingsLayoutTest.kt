package com.slopus.happy.ui.settings

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.GitHubProfile
import com.slopus.happy.model.Profile
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val profile = Profile(
        id = "account-1",
        timestamp = 0,
        firstName = "Ada",
        lastName = "Lovelace",
        avatar = null,
        github = GitHubProfile(id = 1.0, login = "ada", name = "Ada L", avatarUrl = "", email = null, bio = "Analytical engines"),
        connectedServices = listOf("anthropic"),
    )

    @Test
    fun settingsAppCard() {
        rule.setHappyContent { SettingsScreen(versionName = "0.1.0", onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}) }
        val card = rule.node(SettingsTags.APP_CARD).bounds
        assertBox("card", card, 16.dp, (64 + 16).dp, (PHONE_WIDTH - 32).dp, (24 + 90 + 12 + 24).dp)
        assertBox("logotype", rule.node(SettingsTags.LOGOTYPE).bounds, (16 + (PHONE_WIDTH - 32 - 300) / 2f).dp, (64 + 16 + 24).dp, 300.dp, 90.dp)
        // The terminal group has no title: a 16 spacer, then its card.
        val terminal = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[0].bounds
        assertDp("terminal card 16 under the app card", card.bottom + 16.dp, terminal.top)
        rule.onNodeWithText("0.1.0").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun settingsProfileHeader() {
        rule.setHappyContent { SettingsScreen(versionName = "0.1.0", onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}, profile = profile) }
        val card = rule.node(SettingsTags.APP_CARD).bounds
        val avatar = rule.node(SettingsTags.AVATAR).bounds
        assertBox("avatar", avatar, ((PHONE_WIDTH - 90) / 2f).dp, card.top + 24.dp, 90.dp, 90.dp)
        val name = rule.node(SettingsTags.NAME).bounds
        assertDp("name 12 under the avatar", avatar.bottom + 12.dp, name.top)
        assertDp("name centred", (PHONE_WIDTH / 2f).dp, (name.left + name.right) / 2)
        val bio = rule.node(SettingsTags.BIO).bounds
        assertDp("bio 4 under the name", name.bottom + 4.dp, bio.top)
        assertDp("8 and 24 under the bio", bio.bottom + 8.dp + 24.dp, card.bottom)
        rule.onNodeWithText("Ada Lovelace").assertIsDisplayed()
        rule.onAllNodesWithTag(SettingsTags.LOGOTYPE, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun settingsNameWithoutBio() {
        rule.setHappyContent {
            SettingsScreen(versionName = "0.1.0", onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}, profile = profile.copy(github = null))
        }
        val card = rule.node(SettingsTags.APP_CARD).bounds
        val name = rule.node(SettingsTags.NAME).bounds
        assertDp("8 and 24 under the name", name.bottom + 8.dp + 24.dp, card.bottom)
    }

    @Test
    fun settingsRowsAndConnectedAccounts() {
        var claude = 0
        var gitHub = 0
        rule.setHappyContent {
            SettingsScreen(
                versionName = "0.1.0",
                versionSubtitle = "Commit 2026-10-16 03:12 UTC / abc1234",
                onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {},
                profile = profile,
                accounts = ConnectedAccounts(claudeConnected = true, gitHubLogin = "ada"),
                onClaude = { claude++ },
                onGitHub = { gitHub++ },
            )
        }
        rule.onAllNodesWithTag(ItemGroupTags.HEADER, useUnmergedTree = true).assertCountEquals(3)
        for (title in listOf("Scan QR code to authenticate", "Enter URL manually", "Claude Code", "Active", "Connected as @ada", "Agents", "What's New")) {
            rule.onNodeWithText(title).performScrollTo().assertIsDisplayed()
        }
        rule.onNodeWithText("Claude Code").performScrollTo().performClick()
        rule.onNodeWithText("Connected as @ada").performScrollTo().performClick()
        assertEquals(1, claude)
        assertEquals(1, gitHub)
        rule.onNodeWithText("Commit 2026-10-16 03:12 UTC / abc1234").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun settingsDisconnectedAccounts() {
        rule.setHappyContent { SettingsScreen(versionName = "0.1.0", onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}) }
        rule.onNodeWithText("Connect account").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Connect your GitHub account").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun versionSubtitle() {
        assertEquals("Commit 2026-10-16 01:12 UTC / abc1234", buildSubtitle("abc1234def", "2026-10-16T03:12:45+02:00"))
        assertEquals("Commit / abc1234", buildSubtitle("abc1234", null))
        assertEquals("Commit not-a-date", buildSubtitle(null, "not-a-date"))
        assertNull(buildSubtitle(null, ""))
    }

    @Test
    fun tenTapsOnVersionToggleDeveloperMode() {
        var taps = 0
        rule.setHappyContent { SettingsScreen(versionName = versionDetail("1.8.0", 412), onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}, onVersion = { taps++ }) }
        rule.onNodeWithText("1.8.0 (412)").performScrollTo().assertIsDisplayed()
        rule.node(SettingsTags.VERSION).performClick()
        assertEquals(1, taps)

        // useMultiClick: ten within 2 s of each other; a pause starts over.
        var now = 0L
        val clicks = MultiClick(required = 10) { now }
        repeat(9) { assertEquals(false, clicks.click()); now += 1_999 }
        assertEquals(true, clicks.click())
        repeat(5) { clicks.click(); now += 100 }
        now += 2_001
        repeat(9) { assertEquals(false, clicks.click()) }
        assertEquals(true, clicks.click())
    }
}

