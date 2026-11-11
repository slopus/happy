package com.slopus.happy.ui.settings

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.connection.DataStorageTags
import com.slopus.happy.ui.connection.PrivacyTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Fixtures shared by the settings tests. */
object SettingsFixtures {
    val profile = SettingsProfile("0123456789abcdef", "Ada Lovelace", "@ada")
    val accounts = AccountMenu(
        listOf(
            AccountMenuEntry("0123456789abcdef", "Ada Lovelace", active = true),
            AccountMenuEntry("fedcba9876543210", "Work"),
            AccountMenuEntry("agent-connection-1", "Studio", agent = true),
        ),
    )
}

/**
 * A Happy account's Settings, as iOS lays out the page: the big picture,
 * name and username, the accounts card, then its pages and About in iOS's
 * order, Logout last.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val opened = mutableListOf<String>()
    private val actions = HappySettingsActions(
        onAccount = { opened += "account" },
        onBackup = { opened += "backup" },
        onAppearance = { opened += "appearance" },
        onLanguage = { opened += "language" },
        onVoice = { opened += "voice" },
        onAgents = { opened += "agents" },
        onDataStorage = { opened += "storage" },
        onPrivacy = { opened += "privacy" },
        onScanTerminal = { opened += "scan" },
        onEnterTerminal = { opened += "url" },
        onSignOut = { opened += "signOut" },
    )

    private fun show(accountActions: AccountsCardActions = AccountsCardActions({ opened += "switch:$it" }, { opened += "add" })) =
        rule.setHappyContent {
            SettingsScreen(
                profile = SettingsFixtures.profile,
                about = AboutInfo("1.8.0 (412)", "Commit 2026-10-16 03:12 UTC / abc1234"),
                accounts = SettingsFixtures.accounts,
                accountActions = accountActions,
                actions = actions,
            )
        }

    @Test
    fun theProfileIsABigPictureNameAndUsernameCentredUnderTheBar() {
        show()
        val picture = rule.node(SettingsPageTags.PICTURE).bounds
        assertBox("picture", picture, ((PHONE_WIDTH - 100) / 2f).dp, (64 + 8).dp + GlassSpec.feather, 100.dp, 100.dp)
        val name = rule.node(SettingsPageTags.NAME).bounds
        assertDp("name 12 under the picture", picture.bottom + 12.dp, name.top)
        assertBox("name across the page, 24 in", name, 24.dp, name.top, (PHONE_WIDTH - 48).dp, name.bottom - name.top)
        val subtitle = rule.node(SettingsPageTags.SUBTITLE).bounds
        assertDp("line 2 under the name", name.bottom + 2.dp, subtitle.top)
        val accounts = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[0].bounds
        assertDp("cards 28 under the line", subtitle.bottom + 28.dp, accounts.top)
        rule.onNodeWithText("@ada").assertIsDisplayed()
        // A Happy account's picture has no edit badge: nothing here changes it.
        rule.onAllNodesWithTag(SettingsPageTags.EDIT, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun cardsComeInIosOrder() {
        show()
        val cards = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)
        cards.assertCountEquals(8)
        fun cardOf(tag: String): Int {
            val row = rule.node(tag).bounds
            return (0 until 8).first { index -> cards[index].bounds.let { it.top <= row.top && row.bottom <= it.bottom } }
        }
        assertEquals(0, cardOf(SettingsPageTags.ADD_AGENT))
        assertEquals(listOf(1, 1), listOf(SettingsTags.ACCOUNT, SettingsTags.BACKUP).map(::cardOf))
        assertEquals(listOf(2, 2, 2, 2, 2), listOf(SettingsTags.APPEARANCE, SettingsTags.LANGUAGE, SettingsTags.VOICE, SettingsTags.AGENTS, DataStorageTags.ROW).map(::cardOf))
        assertEquals(listOf(3, 3), listOf(SettingsTags.SCAN_TERMINAL, SettingsTags.ENTER_TERMINAL).map(::cardOf))
        assertEquals(4, cardOf(SettingsTags.SUPPORT))
        // Privacy, a card of its own between Support us and About.
        rule.node(PrivacyTags.ROW).performScrollTo()
        assertEquals(5, cardOf(PrivacyTags.ROW))
        rule.node(SettingsTags.VERSION).performScrollTo()
        assertEquals(6, cardOf(SettingsTags.VERSION))
        rule.node(SettingsPageTags.REMOVE).performScrollTo()
        assertEquals(7, cardOf(SettingsPageTags.REMOVE))
        // happy-app's Connected Accounts are gone, as on iOS; no titled groups at all.
        rule.onAllNodesWithTag(ItemGroupTags.HEADER, useUnmergedTree = true).assertCountEquals(0)
        rule.onNode(hasText("Claude Code")).assertDoesNotExist()
    }

    @Test
    fun everyRowOpensItsPage() {
        show()
        for (tag in listOf(SettingsTags.ACCOUNT, SettingsTags.BACKUP, SettingsTags.APPEARANCE, SettingsTags.LANGUAGE, SettingsTags.VOICE, SettingsTags.AGENTS, DataStorageTags.ROW, SettingsTags.SCAN_TERMINAL, SettingsTags.ENTER_TERMINAL, PrivacyTags.ROW)) {
            rule.node(tag).performScrollTo().performClick()
        }
        assertEquals(listOf("account", "backup", "appearance", "language", "voice", "agents", "storage", "scan", "url", "privacy"), opened)
        for (title in listOf("What's New", "GitHub", "slopus/happy", "Report an Issue", "Privacy Policy", "Terms of Service", "1.8.0 (412)", "Commit 2026-10-16 03:12 UTC / abc1234")) {
            rule.onNodeWithText(title).performScrollTo().assertIsDisplayed()
        }
    }

    @Test
    fun theAccountsCardChecksTheOpenOneSwitchesAndAdds() {
        show()
        rule.node(SettingsPageTags.account("0123456789abcdef")).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(SettingsPageTags.account("agent-connection-1")).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        // The open one stays open.
        rule.node(SettingsPageTags.account("0123456789abcdef")).performClick()
        rule.node(SettingsPageTags.account("fedcba9876543210")).performClick()
        rule.node(SettingsPageTags.account("agent-connection-1")).performClick()
        rule.node(SettingsPageTags.ADD_AGENT).performClick()
        assertEquals(listOf("switch:fedcba9876543210", "switch:agent-connection-1", "add"), opened)
        // An account's picture takes the tile's place: 30, in the 32 icon slot.
        val icons = rule.onAllNodesWithTag(ItemTags.ICON, useUnmergedTree = true)
        assertDp("icon slot", 32.dp, icons[0].bounds.let { it.right - it.left })
    }

    @Test
    fun holdingAnAgentDisconnectsItAfterAConfirm() {
        val removed = mutableListOf<String>()
        show(AccountsCardActions({}, {}, onRemove = { removed += it.id }, canRemove = { it.agent || it.active }))
        // Another Happy account can't go from here: holding it offers nothing.
        rule.node(SettingsPageTags.account("fedcba9876543210")).performTouchInput { longClick() }
        rule.onNode(hasText("Logout") and hasAnyAncestor(isPopup())).assertDoesNotExist()

        rule.node(SettingsPageTags.account("agent-connection-1")).performTouchInput { longClick() }
        rule.onNodeWithText("Disconnect").performClick()
        rule.onNodeWithText("Disconnect Happy Agent?").assertIsDisplayed()
        rule.onNode(hasText("Disconnect") and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        assertEquals(listOf("agent-connection-1"), removed)
    }

    @Test
    fun logoutAsksFirst() {
        show()
        rule.node(SettingsPageTags.REMOVE).performScrollTo().performClick()
        rule.onNodeWithText("Sign out of Happy CLI?").assertIsDisplayed()
        rule.onNodeWithText("Cancel").performClick()
        rule.waitForIdle()
        assertEquals(emptyList<String>(), opened)
        rule.node(SettingsPageTags.REMOVE).performClick()
        rule.onNode(hasText("Logout") and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        assertEquals(listOf("signOut"), opened)
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
        rule.setHappyContent {
            SettingsScreen(SettingsFixtures.profile, AboutInfo(versionDetail("2026.11.12", 412)), aboutActions = AboutActions(onVersion = { taps++ }))
        }
        rule.onNodeWithText("2026.11.12 (412)").performScrollTo().assertIsDisplayed()
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
