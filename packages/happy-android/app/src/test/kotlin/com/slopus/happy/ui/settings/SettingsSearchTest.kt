package com.slopus.happy.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.Settings
import com.slopus.happy.model.settings.PushToken
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.components.ProvideRowReveal
import com.slopus.happy.ui.connection.AgentConnectionSettingsScreen
import com.slopus.happy.ui.connection.AgentPagesTags
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.connection.AgentSettingsActions
import com.slopus.happy.ui.connection.agentAppearanceSections
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.voice.VoiceSettingsScreen
import com.slopus.happy.ui.voice.VoiceUsageReading
import com.slopus.happy.ui.voice.voicePageEntries
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Settings' search, as iOS's SettingsViewController has it: the bar's
 * search button turns the bar into a field and hides the picture, name and
 * cards; what is typed finds accounts, the page's rows and its pages' rows
 * in one card under the bar, or says "Nothing found"; a page's row opens
 * that page, which scrolls to the row and flashes it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsSearchTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val done = mutableListOf<String>()

    private fun showHappy() = rule.setHappyContent {
        SettingsScreen(
            profile = SettingsFixtures.profile,
            about = AboutInfo("1.8.0 (412)"),
            accounts = SettingsFixtures.accounts,
            accountActions = AccountsCardActions({ done += "switch:$it" }, { done += "add" }),
            actions = HappySettingsActions(onAccount = { done += "account" }, onAppearance = { done += "appearance" }, onSignOut = { done += "signOut" }),
            pages = accountPageEntries("anon", "public", "Ada Lovelace", "ada", null) { done += "account@$it" } +
                languagePageEntries(null, "English") { done += "language@$it" },
        )
    }

    private fun search(text: String) {
        rule.node(SettingsSearchTags.OPEN).performClick()
        if (text.isNotEmpty()) rule.node(AgentSearchTags.FIELD).performTextInput(text)
        rule.waitForIdle()
    }

    private fun resultTitles(): List<String> {
        val rows = rule.onAllNodesWithTag(ItemTags.TITLE, useUnmergedTree = true).fetchSemanticsNodes()
        return rows.map { it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("") { t -> t.text } }
    }

    @Test
    fun searchingHidesThePictureNameAndCards() {
        showHappy()
        rule.node(SettingsPageTags.PICTURE).assertExists()
        search("")
        rule.onAllNodesWithTag(SettingsPageTags.PICTURE, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(SettingsPageTags.NAME, useUnmergedTree = true).assertCountEquals(0)
        // Nothing typed: nothing shows, not even "Nothing found".
        rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(SettingsSearchTags.NOTHING_FOUND, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun foundRowsAreOneCardEightUnderTheBar() {
        showHappy()
        search("app")
        val cards = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)
        cards.assertCountEquals(1)
        assertDp("card 8 under the 64 bar and its feather", (64 + 8).dp() + GlassSpec.feather, cards[0].bounds.top)
        assertEquals(listOf("Appearance"), resultTitles())
    }

    @Test
    fun nothingFoundIsOneCentredLineUnderTheBar() {
        showHappy()
        search("zzzz")
        rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true).assertCountEquals(0)
        val line = rule.node(SettingsSearchTags.NOTHING_FOUND).bounds
        assertBox("nothing found", line, 0.dp(), (64 + 40).dp() + GlassSpec.feather, PHONE_WIDTH.dp(), line.bottom - line.top)
        rule.node(SettingsSearchTags.NOTHING_FOUND).assertTextEquals("Nothing found")
    }

    @Test
    fun accountsComeFirstWithTheirKindAndOpenWhenTapped() {
        showHappy()
        search("o")
        val titles = resultTitles()
        // The accounts whose name holds it lead; Logout, which signs out, is never offered.
        assertEquals(listOf("Ada Lovelace", "Work", "Studio"), titles.take(3))
        assertTrue("no sign out in $titles", titles.none { it == "Logout" })
        // Each says its kind by its product: Happy Agent, or Happy CLI for a Happy account (iOS 64edb6a34).
        rule.onNodeWithText("Happy Agent", useUnmergedTree = true).assertExists()
        rule.onAllNodesWithText("Happy CLI", useUnmergedTree = true).assertCountEquals(2)
        rule.node(SettingsSearchTags.profile("fedcba9876543210")).performClick()
        assertEquals(listOf("switch:fedcba9876543210"), done)
        // The search closed: the page is back.
        rule.node(SettingsPageTags.PICTURE).assertExists()
    }

    @Test
    fun aPagesRowOpensThePageAtTheRowAndClosesTheSearch() {
        showHappy()
        search("public")
        assertEquals(listOf("Public ID"), resultTitles())
        rule.node(AccountTags.PUBLIC_ID).performClick()
        assertEquals(listOf("account@${AccountTags.PUBLIC_ID}"), done)
        rule.node(SettingsPageTags.PICTURE).assertExists()
    }

    @Test
    fun languagesAreFoundByTheirOwnNames() {
        showHappy()
        search("polski")
        assertEquals(listOf("Polski"), resultTitles())
    }

    @Test
    fun backClosesTheSearch() {
        showHappy()
        search("app")
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.node(SettingsPageTags.PICTURE).assertExists()
        rule.node(SettingsTags.APPEARANCE).assertExists()
    }

    @Test
    fun agentSettingsFindThePicturesAsksAndChangeAppearanceInPlace() {
        val themes = mutableListOf<ThemePreference>()
        rule.setHappyContent {
            AgentConnectionSettingsScreen(
                profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
                accounts = SettingsFixtures.accounts,
                actions = AgentSettingsActions(onAskChief = { done += it }, onAppearance = { done += "appearance" }),
                about = AboutInfo("1.8.0 (412)"),
                appearance = agentAppearanceSections(ThemePreference.Adaptive, { themes += it }, true, {}).flatMap { it.rows },
            )
        }
        search("name")
        assertEquals(listOf("Edit name"), resultTitles())
        rule.onNodeWithText("Edit name").performClick()
        assertEquals(listOf("Change your name to "), done)
        rule.node(SettingsPageTags.PICTURE).assertExists()

        search("dark")
        rule.node(AgentPagesTags.theme(ThemePreference.Dark)).performClick()
        assertEquals(listOf(ThemePreference.Dark), themes)
        // In place: the search stays open.
        rule.node(AgentSearchTags.FIELD).assertExists()

        rule.node(AgentSearchTags.FIELD).performTextReplacement("hide")
        rule.node(AgentPagesTags.HIDE_PROJECTS).assertIsOn()
    }

    @Test
    fun aRevealedRowIsScrolledToTheMiddleOfWhatShows() {
        val tokens = (1..12).map { PushToken(id = "t$it", token = "ExponentPushToken[token-$it]", createdAt = 0, updatedAt = 0) }
        rule.setHappyContent {
            ProvideRowReveal(AccountTags.PUSH_REREGISTER) {
                AccountScreen(anonId = "anon", publicId = "public", analyticsOptOut = false, onAnalyticsOptOutChange = {}, onBack = {}, push = PushState(tokens = tokens))
            }
        }
        rule.waitForIdle()
        val row = rule.node(AccountTags.PUSH_REREGISTER).bounds
        // Between the 64 bar and the bottom of the 891 window.
        // What shows clearly: below the bar and its feather.
        val clear = 64 + GlassSpec.feather.value
        assertDp("row's middle in the middle", (clear + (891 - clear) / 2f).dp(), (row.top + row.bottom) / 2)
    }

    /** What search finds of a page is what the page shows: every entry's row is there, by the same title. */
    private fun assertPageShows(entries: @Composable () -> List<SettingsEntry>, page: @Composable () -> Unit) {
        var found = emptyList<SettingsEntry>()
        rule.setHappyContent {
            found = entries()
            page()
        }
        rule.waitForIdle()
        assertTrue(found.isNotEmpty())
        for (entry in found) {
            rule.onNode(hasTestTag(entry.id) and hasAnyDescendant(hasText(entry.title)), useUnmergedTree = true).assertExists()
        }
    }

    @Test
    fun accountEntriesNameItsRows() = assertPageShows(
        { accountPageEntries("anon", "public", "Ada", "ada", "example.com") {} },
        { AccountScreen("anon", "public", false, {}, {}, displayName = "Ada", username = "ada", server = "example.com") },
    )

    @Test
    fun backupEntriesNameItsRows() = assertPageShows({ backupPageEntries {} }, { BackupScreen("AAAAA-BBBBB", {}) })

    @Test
    fun voiceEntriesNameItsRows() = assertPageShows(
        { voicePageEntries(Settings.Defaults, hasPro = false) {} },
        { VoiceSettingsScreen(Settings.Defaults, {}, VoiceUsageReading.Unavailable, false, onSupport = {}, onLanguage = {}, onBack = {}) },
    )

    @Test
    fun languageEntriesNameItsRows() {
        assertPageShows({ languagePageEntries("pl", "English") {} }, { LanguageScreen("pl", "English", {}, {}) })
        rule.onAllNodesWithTag(LanguageTags.row("pl"), useUnmergedTree = true).assertCountEquals(1)
    }

    private fun Int.dp() = androidx.compose.ui.unit.Dp(this.toFloat())
    private fun Float.dp() = androidx.compose.ui.unit.Dp(this)
}
