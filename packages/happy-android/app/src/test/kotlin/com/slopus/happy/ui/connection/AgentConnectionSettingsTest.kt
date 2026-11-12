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
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
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
        onPrivacy = { done += "privacy" },
    )

    private fun show(dark: Boolean = false, daemonVersion: String? = null, voice: AgentVoiceSummary = AgentVoiceSummary(com.slopus.happy.call.CallAllowance.FREE_MILLIS)) = rule.setHappyContent(dark) {
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
            voice = voice,
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
        // Desktop's first group (Appearance, Profile, Voice), then Support Happy, a card of its own and the page's only Support us; Agents is under AGENTS.
        rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true).assertCountEquals(6)
        rule.onNode(hasText("Steve") and hasAnyAncestor(hasTestTag(SettingsPageTags.account("account-1"))), useUnmergedTree = true).assertExists()
        rule.node(SettingsPageTags.account("agent-connection-2")).performClick()
        rule.node(SettingsPageTags.ADD_AGENT).performScrollTo().performClick()
        rule.node(AgentSettingsTags.PROFILE).performScrollTo().performClick()
        rule.node(AgentSettingsTags.APPEARANCE).performScrollTo().performClick()
        assertEquals(listOf("switch:agent-connection-2", "add", "profile", "appearance"), done)
        rule.node(SettingsTags.SUPPORT).assertDoesNotExist()
        rule.node(SettingsTags.MANAGE_SUBSCRIPTIONS).assertDoesNotExist()
        rule.node(SettingsTags.VERSION).performScrollTo().assertIsDisplayed()
        val first = hasTestTag(ItemGroupTags.CARD) and hasAnyDescendant(hasTestTag(AgentSettingsTags.APPEARANCE)) and
            hasAnyDescendant(hasTestTag(AgentSettingsTags.PROFILE)) and hasAnyDescendant(hasTestTag(AgentVoiceTags.ROW))
        rule.onNode(first, useUnmergedTree = true).assertExists()
        rule.onNode(first and hasAnyDescendant(hasTestTag(AgentVoiceTags.SUPPORT)), useUnmergedTree = true).assertDoesNotExist()
        rule.node(AgentVoiceTags.ROW).performScrollTo().assertIsDisplayed()
    }

    /** Privacy is a card of its own, after Appearance's; it opens the page with this phone's Analytics switch. */
    @Test
    fun privacyIsACardOfItsOwn() {
        show()
        val privacy = hasTestTag(ItemGroupTags.CARD) and hasAnyDescendant(hasTestTag(PrivacyTags.ROW))
        rule.onNode(privacy, useUnmergedTree = true).assertExists()
        rule.onNode(privacy and hasAnyDescendant(hasTestTag(AgentSettingsTags.APPEARANCE)), useUnmergedTree = true).assertDoesNotExist()
        assertTrue(rule.node(PrivacyTags.ROW).bounds.top > rule.node(AgentSettingsTags.APPEARANCE).bounds.bottom)
        rule.onNode(hasTestTag(PrivacyTags.ROW) and hasAnyDescendant(hasText("Privacy")), useUnmergedTree = true).assertExists()
        rule.node(PrivacyTags.ROW).performScrollTo().performClick()
        assertEquals(listOf("privacy"), done)
    }

    /** Privacy's page: the Analytics switch, the words on what it shares under it. */
    @Test
    fun privacyHoldsTheAnalyticsSwitch() {
        val set = mutableListOf<Boolean>()
        rule.setHappyContent { PrivacyScreen(analytics = true, onAnalytics = { set += it }, onBack = {}) }
        rule.onNodeWithText("Privacy").assertIsDisplayed()
        rule.onNodeWithText("Analytics").assertIsDisplayed()
        rule.onNodeWithText("Shares usage data", substring = true).assertIsDisplayed()
        rule.node(PrivacyTags.ANALYTICS_SWITCH).assertIsOn().performClick()
        assertEquals(listOf(false), set)
    }

    /** A local agent: Notifications (it was Sharing) after Data and Storage, a bell on red, and no Team at all. */
    @Test
    fun aLocalAgentsNotificationsCloseTheFirstGroupAndThereIsNoTeam() {
        var opened = 0
        rule.setHappyContent {
            AgentConnectionSettingsScreen(
                profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
                accounts = accounts,
                actions = AgentSettingsActions(onDataStorage = {}, onSharing = { opened++ }, onAgents = {}),
                about = AboutInfo("1.8.0 (412)"),
            )
        }
        rule.onNode(
            hasTestTag(ItemGroupTags.CARD) and hasAnyDescendant(hasTestTag(DataStorageTags.ROW)) and hasAnyDescendant(hasTestTag(AgentSharingTags.ROW)),
            useUnmergedTree = true,
        ).assertExists()
        rule.onNode(hasTestTag(AgentSharingTags.ROW) and hasAnyDescendant(hasText("Notifications")), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("TEAM").assertDoesNotExist()
        rule.onNodeWithText("Sharing").assertDoesNotExist()
        rule.node(AgentSharingTags.ROW).performScrollTo().performClick()
        assertEquals(1, opened)
    }

    /** Search finds Notifications once, and its switches by their own titles, which open the page on them. */
    @Test
    fun searchFindsNotificationsOnceAndItsSwitches() {
        val revealed = mutableListOf<String>()
        rule.setHappyContent {
            AgentConnectionSettingsScreen(
                profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
                accounts = accounts,
                actions = AgentSettingsActions(onSharing = {}, onNotifications = {}, onNotificationsRow = { revealed += it }),
                about = AboutInfo("1.8.0 (412)"),
            )
        }
        rule.node(com.slopus.happy.ui.settings.SettingsSearchTags.OPEN).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("Notif")
        rule.waitForIdle()
        rule.onAllNodes(hasText("Notifications"), useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Notifications from this server").assertExists()
        rule.node(AgentSearchTags.FIELD).performTextClearance()
        rule.node(AgentSearchTags.FIELD).performTextInput("Join other")
        rule.waitForIdle()
        rule.onNodeWithText("Join other people’s tasks").performClick()
        assertEquals(listOf(AgentSharingTags.row(com.slopus.happy.agent.AutoJoinKind.Tasks)), revealed)
    }

    /**
     * On Happy Cloud, desktop's groups: Data and Storage and Notifications
     * close the first, Agents is Agents, Inference, Compute then Usage, Team is
     * Members alone; each headed by its name, and no Advanced. Sharing is
     * notifications: one Notifications row, and no Sharing.
     */
    @Test
    fun cloudRowsAreInDesktopsGroups() {
        rule.setHappyContent {
            AgentConnectionSettingsScreen(
                profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
                accounts = accounts,
                actions = AgentSettingsActions(onDataStorage = {}, onSharing = {}, onAgents = {}, onMembers = {}, onProviders = {}, onCompute = {}, onNotifications = {}, onUsage = {}),
                about = AboutInfo("1.8.0 (412)"),
            )
        }
        fun card(vararg tags: String) = rule.onNode(tags.fold(hasTestTag(ItemGroupTags.CARD)) { m, t -> m and hasAnyDescendant(hasTestTag(t)) }, useUnmergedTree = true)
        card(AgentSettingsTags.APPEARANCE, AgentVoiceTags.ROW, DataStorageTags.ROW, CloudPushTags.ROW).assertExists()
        card(AgentAgentsTags.ROW, CloudProvidersTags.ROW, ComputeTags.ROW, AgentUsageTags.ROW).assertExists()
        card(CloudTags.MEMBERS).assertExists()
        card(AgentSharingTags.ROW, CloudTags.MEMBERS).assertDoesNotExist()
        rule.onAllNodesWithTag(AgentSharingTags.ROW, useUnmergedTree = true).assertCountEquals(1)
        rule.onNode(hasTestTag(AgentSharingTags.ROW) and hasAnyDescendant(hasText("Notifications")), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Sharing").assertDoesNotExist()
        // Right after Data and Storage.
        assertTrue(rule.onNode(hasTestTag(AgentSharingTags.ROW), useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y > rule.onNode(hasTestTag(DataStorageTags.ROW), useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y)
        rule.onNode(hasTestTag(ItemGroupTags.CARD) and hasAnyDescendant(hasTestTag(DataStorageTags.ROW)) and hasAnyDescendant(hasTestTag(ComputeTags.ROW)), useUnmergedTree = true).assertDoesNotExist()
        rule.onNodeWithText("AGENTS").assertExists()
        rule.onNodeWithText("TEAM").assertExists()
        rule.onNodeWithText("ADVANCED").assertDoesNotExist()
        rule.onNode(hasTestTag(ComputeTags.ROW) and hasAnyDescendant(hasText("Compute")), useUnmergedTree = true).assertExists()
        rule.onNode(hasTestTag(CloudProvidersTags.ROW) and hasAnyDescendant(hasText("Inference")), useUnmergedTree = true).assertExists()
        rule.onNode(hasTestTag(AgentUsageTags.ROW) and hasAnyDescendant(hasText("Usage")), useUnmergedTree = true).assertExists()
        // Usage closes the group, under Compute.
        assertTrue(rule.onNode(hasTestTag(AgentUsageTags.ROW), useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y > rule.onNode(hasTestTag(ComputeTags.ROW), useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y)
    }

    /**
     * The boba row: "Happy is open source" and, under it at the same size in
     * the page's secondary grey, the ask. The boba is a tile's 30 in the 32
     * icon box at the top-left, where a one-line row's tile is (its middle
     * 28 from the top, 16 in), level with the title's first line; the row
     * grows for the words, the boba stays.
     */
    @Test
    fun theBobaRowIsATileAtTheTopWithTwoLines() {
        show()
        val row = rule.node(AgentVoiceTags.SUPPORT).performScrollTo().bounds
        val art = rule.node(AgentVoiceTags.SUPPORT_ART).bounds
        val title = rule.node(AgentVoiceTags.SUPPORT_TITLE).bounds
        val line = rule.node(AgentVoiceTags.SUPPORT_LINE).bounds
        assertBox("icon box", art, row.left + 16.dp, row.top + 12.dp, 32.dp, 32.dp)
        // The boba on its orange tile, a row tile's size, in the box.
        assertBox("tile", rule.node(AgentVoiceTags.SUPPORT_TILE).bounds, art.left + 1.dp, art.top + 1.dp, 30.dp, 30.dp)
        assertDp("title's first line level with the boba", (art.top + art.bottom) / 2, title.top + 12.dp)
        assertDp("title after the icon box", art.right + 12.dp, title.left)
        assertDp("line under the title", title.bottom, line.top)
        assertTrue("the row grows for both lines", row.height > 56.dp)
        rule.onNodeWithText("Happy is open source").assertIsDisplayed()
        rule.onNodeWithText("Support by sending us boba, get 2 hours of calls with agents").assertIsDisplayed()
    }

    /** A subscriber's boba row thanks them and says where to manage it; it still opens Support Happy. */
    @Test
    fun aSubscribersBobaRowThanks() {
        show(voice = AgentVoiceSummary(4 * 3_600_000L, offer = com.slopus.happy.payments.Offer.Subscribed))
        rule.node(AgentVoiceTags.SUPPORT).performScrollTo()
        rule.onNodeWithText("Thank you for supporting Happy").assertIsDisplayed()
        rule.onNodeWithText("Manage your subscription").assertIsDisplayed()
        rule.onNodeWithText("Happy is open source").assertDoesNotExist()
        rule.node(AgentVoiceTags.SUPPORT).performClick()
        rule.waitForIdle()
        assertEquals(listOf("support"), done)
    }

    /** The boba row pushes Support Happy's page ([SupportScreen]; its content in CallSheetTest). */
    @Test
    fun theBobaRowOpensSupport() {
        show()
        rule.node(AgentVoiceTags.SUPPORT).performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(listOf("support"), done)
    }

    /** A subscriber's Voice page: the plan's hours, a thank-you instead of the pledge, no free row. */
    @Test
    fun aSubscribersVoicePageThanksAndOffersNothing() {
        rule.setHappyContent { AgentVoiceScreen(AgentVoiceSummary(4 * 3_600_000L, offer = com.slopus.happy.payments.Offer.Subscribed)) {} }
        rule.onNodeWithText("Thank you for your support!").assertIsDisplayed()
        rule.onNodeWithText("Get 2 hrs of voice").assertDoesNotExist()
        rule.node(AgentVoiceTags.FREE).assertDoesNotExist()
        rule.node(AgentVoiceTags.SUBSCRIBE).assertHasNoClickAction()
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
