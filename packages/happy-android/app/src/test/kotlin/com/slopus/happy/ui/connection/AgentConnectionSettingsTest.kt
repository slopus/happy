package com.slopus.happy.ui.connection

import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentProfileState
import com.slopus.happy.agent.CompletionSound
import com.slopus.happy.agent.WireProfile
import com.slopus.happy.agent.WireProfilePhoto
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.settings.AboutActions
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.AccountsCardActions
import com.slopus.happy.ui.settings.SettingsPageTags
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.settings.SettingsTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Assert.assertTrue
import androidx.compose.ui.test.onNodeWithTag
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * An agent connection's settings, as iOS lays out a connection's page: the
 * agent's picture with its edit menu, the accounts, the person's Profile,
 * Appearance with Hide projects, Support us, About, Disconnect after asking.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentConnectionSettingsTest {
    @get:Rule val rule = createComposeRule()

    private val done = mutableListOf<String>()
    private var page = 0

    private val accounts = AccountMenu(
        listOf(
            AccountMenuEntry("account-1", "Steve"),
            AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true),
            AccountMenuEntry("agent-connection-2", "Laptop", agent = true),
        ),
    )

    private val actions = AgentSettingsActions(
        onProfile = { done += "profile" },
        onAppearance = { done += "appearance" },
        onRemove = { done += "remove" },
        onAskChief = { done += it },
    )

    private fun show(dark: Boolean = false, daemonVersion: String? = null) = rule.setHappyContent(dark) {
        page = HappyTheme.colors.grouped.background.toArgb()
        AgentConnectionSettingsScreen(
            profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
            accounts = accounts,
            actions = actions,
            about = AboutInfo("1.8.0 (412)"),
            accountActions = AccountsCardActions({ done += "switch:$it" }, { done += "add" }),
            person = AgentPerson("Steve"),
            daemonVersion = daemonVersion,
            aboutActions = AboutActions(onSupport = { done += "support" }),
        )
    }

    @Test
    fun theComputersVersionIsReadOnlyAndDistinctFromThePhones() {
        show(daemonVersion = "0.4.109")
        val row = rule.node(AgentSettingsTags.DAEMON_VERSION)
        row.performScrollTo().assertHasNoClickAction()
        rule.onNodeWithText("Happy Agent · Version").assertIsDisplayed()
        rule.onNodeWithText("0.4.109").assertIsDisplayed()
        assertDp("version row height", 64, row.bounds.height)
        rule.onNode(hasTestTag(ItemTags.CHEVRON) and hasAnyAncestor(hasTestTag(AgentSettingsTags.DAEMON_VERSION)), useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun theAgentsPictureHeadsThePageWithAPencilBadge() {
        show()
        val picture = rule.node(SettingsPageTags.PICTURE).bounds
        assertBox("picture", picture, ((PHONE_WIDTH - 100) / 2f).dp, (64 + 8).dp + GlassSpec.feather, 100.dp, 100.dp)
        assertBox("badge in its corner", rule.node(SettingsPageTags.EDIT).bounds, picture.right - 32.dp, picture.bottom - 32.dp, 32.dp, 32.dp)
        rule.onNode(hasText("Studio") and hasTestTag(SettingsPageTags.NAME), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Connected").assertIsDisplayed()
        val name = rule.node(SettingsPageTags.NAME).bounds
        assertDp("name 12 under", picture.bottom + 12.dp, name.top)
    }

    @Test
    fun thePicturesMenuAsksTheChiefWithAnUnsentPrefix() {
        show()
        rule.node(SettingsPageTags.PICTURE).performClick()
        rule.node(SettingsPageTags.EDIT_AVATAR).performClick()
        rule.node(SettingsPageTags.PICTURE).performClick()
        rule.node(SettingsPageTags.EDIT_NAME).performClick()
        assertEquals(listOf("Change your avatar to ", "Change your name to "), done)
    }

    @Test
    fun cardsAndRows() {
        show()
        // Support Happy is a card of its own, right under Profile.
        rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true).assertCountEquals(7)
        rule.onNode(hasText("Steve") and hasAnyAncestor(hasTestTag(SettingsPageTags.account("account-1"))), useUnmergedTree = true).assertExists()
        rule.node(SettingsPageTags.account("agent-connection-2")).performClick()
        rule.node(SettingsPageTags.ADD_AGENT).performScrollTo().performClick()
        rule.node(AgentSettingsTags.PROFILE).performScrollTo().performClick()
        rule.node(AgentSettingsTags.APPEARANCE).performScrollTo().performClick()
        assertEquals(listOf("switch:agent-connection-2", "add", "profile", "appearance"), done)
        rule.node(SettingsTags.SUPPORT).performScrollTo().assertIsDisplayed()
        rule.node(SettingsTags.VERSION).performScrollTo().assertIsDisplayed()
        assertTrue(rule.node(AgentVoiceTags.SUPPORT).bounds.top > rule.node(AgentSettingsTags.PROFILE).bounds.bottom)
        assertTrue(rule.node(AgentVoiceTags.SUPPORT).bounds.bottom < rule.node(AgentSettingsTags.APPEARANCE).bounds.top)
        rule.node(AgentVoiceTags.ROW).performScrollTo().assertIsDisplayed()
    }

    /** The boba row opens Support us, the app's offer sheet ([com.slopus.happy.payments.OfferSheet.Support]; its content in CallSheetTest). */
    @Test
    fun theBobaRowOpensSupport() {
        show()
        rule.node(AgentVoiceTags.SUPPORT).performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(listOf("support"), done)
    }

    @Test
    fun disconnectingAsksAndCancelKeepsTheConnection() {
        show()
        rule.node(SettingsPageTags.REMOVE).performScrollTo().performClick()
        rule.onNodeWithText("Disconnect Happy Agent?").assertIsDisplayed()
        rule.onNodeWithText("Cancel").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Disconnect Happy Agent?").assertDoesNotExist()
        assertEquals(emptyList<String>(), done)

        rule.node(SettingsPageTags.REMOVE).performClick()
        rule.onNode(hasText("Disconnect") and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        assertEquals(listOf("remove"), done)
    }

    private fun barCorner(): Int {
        val bar = rule.node(AgentSettingsTags.BAR).captureToImage().toPixelMap()
        // A corner of the bar, clear of the back arrow and the title.
        return bar[bar.width - 4, 4].toArgb()
    }

    @Test
    fun theBarIsThePagesOwnGreyInLight() {
        show(dark = false)
        assertGround(page, barCorner())
    }

    @Test
    fun theBarIsThePagesOwnColourInDark() {
        show(dark = true)
        assertGround(page, barCorner())
    }

    /** The bar is glass over the page: its ground composites over the same colour and may round a step off it. */
    private fun assertGround(expected: Int, actual: Int) {
        for (shift in listOf(16, 8, 0)) {
            val step = (actual shr shift and 0xff) - (expected shr shift and 0xff)
            org.junit.Assert.assertTrue("#${Integer.toHexString(actual)} vs #${Integer.toHexString(expected)}", step in -1..1)
        }
    }

    @Test
    fun appearanceChecksTheThemeAndSwitchesHideProjects() {
        val themes = mutableListOf<ThemePreference>()
        val hidden = mutableListOf<Boolean>()
        rule.setHappyContent {
            AgentAppearanceScreen(ThemePreference.Dark, { themes += it }, projectsHidden = true, onProjectsHidden = { hidden += it }, onBack = {})
        }
        rule.node(AgentPagesTags.theme(ThemePreference.Light)).performClick()
        assertEquals(listOf(ThemePreference.Light), themes)
        rule.node(AgentPagesTags.HIDE_PROJECTS).assertIsOn().performClick()
        assertEquals(listOf(false), hidden)
        rule.onNodeWithText("Home leaves your projects out, here and in Happy Desktop.").assertIsDisplayed()
    }

    @Test
    fun appearanceChecksTheCompletionSoundAndPicksAnother() {
        val picked = mutableListOf<CompletionSound>()
        rule.setHappyContent {
            AgentAppearanceScreen(ThemePreference.Adaptive, {}, projectsHidden = false, onProjectsHidden = {}, onBack = {}, completionSound = CompletionSound.Focused, onCompletionSound = { picked += it })
        }
        rule.onNodeWithText("COMPLETION SOUND").performScrollTo().assertIsDisplayed()
        rule.node(AgentPagesTags.sound(CompletionSound.Never)).performScrollTo().performClick()
        assertEquals(listOf(CompletionSound.Never), picked)
        rule.onNode(hasTestTag(AgentPagesTags.sound(CompletionSound.Focused)) and hasAnyDescendant(hasText("When focused")), useUnmergedTree = true).assertExists()
        rule.onNode(hasTestTag(AgentPagesTags.sound(CompletionSound.Always)) and hasAnyDescendant(hasText("Always")), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("A chime when a conversation finishes", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun appearanceShowsProjectsByDefault() {
        rule.setHappyContent { AgentAppearanceScreen(ThemePreference.Adaptive, {}, projectsHidden = false, onProjectsHidden = {}, onBack = {}) }
        rule.node(AgentPagesTags.HIDE_PROJECTS).assertIsOff()
    }

    @Test
    fun theProfilePageHasThePictureChangePhotoTheNameAndRemove() {
        val done = mutableListOf<String>()
        val state = AgentProfileState(WireProfile(name = "Steve", photo = WireProfilePhoto("abc"), version = "v1"))
        rule.setHappyContent {
            AgentProfileScreen("seed", state, photo = null, onRename = { done += "rename:$it" }, onChangePhoto = { done += "photo" }, onRemovePhoto = { done += "remove" }, onBack = {})
        }
        val picture = rule.node(AgentPagesTags.PICTURE).bounds
        assertBox("picture", picture, ((PHONE_WIDTH - 100) / 2f).dp, (64 + 16).dp + GlassSpec.feather, 100.dp, 100.dp)
        val change = rule.node(AgentPagesTags.CHANGE_PHOTO).bounds
        assertDp("Change Photo 8 under", picture.bottom + 8.dp, change.top)
        rule.node(AgentPagesTags.CHANGE_PHOTO).performClick()
        rule.node(AgentPagesTags.REMOVE_PHOTO).performClick()
        rule.onNodeWithText("Steve").assertIsDisplayed()
        assertEquals(listOf("photo", "remove"), done)
    }

    @Test
    fun withoutAPictureThereIsNothingToRemove() {
        rule.setHappyContent {
            AgentProfileScreen("seed", AgentProfileState(WireProfile(name = "Steve", version = "v1")), null, {}, {}, {}, {})
        }
        rule.onAllNodesWithTag(AgentPagesTags.REMOVE_PHOTO, useUnmergedTree = true).assertCountEquals(0)
    }
}
