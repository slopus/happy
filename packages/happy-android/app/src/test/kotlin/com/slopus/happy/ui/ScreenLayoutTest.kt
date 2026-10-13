package com.slopus.happy.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.AuthApi.ServerProbe
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.server.ServerScreen
import com.slopus.happy.ui.server.ServerTags
import com.slopus.happy.ui.settings.AccountScreen
import com.slopus.happy.ui.settings.AccountTags
import com.slopus.happy.ui.settings.AppearanceScreen
import com.slopus.happy.ui.settings.SettingsScreen
import com.slopus.happy.ui.settings.SettingsTags
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun homeHeader() {
        rule.setHappyContent { HomeScreen(onSettings = {}) }
        // Logo: 32 box centred in the 48 left slot; settings: 44 button centred in the 48 right slot.
        assertBox("logo box", rule.node(HomeTags.LOGO).bounds, 24.dp, 16.dp, 32.dp, 32.dp)
        assertBox("settings button", rule.node(HomeTags.SETTINGS).bounds, (PHONE_WIDTH - 16 - 46).dp, 10.dp, 44.dp, 44.dp)
        val title = rule.node(HeaderTags.TITLE).bounds
        assertDp("title centred", (PHONE_WIDTH / 2f).dp, (title.left + title.right) / 2)
        assertDp("title line height", 20, title.bottom - title.top)
        val empty = rule.node(HomeTags.EMPTY).bounds
        assertDp("empty state centred", (PHONE_WIDTH / 2f).dp, (empty.left + empty.right) / 2)
    }

    @Test
    fun serverFormSpec() {
        rule.setHappyContent {
            ServerScreen(customUrl = "https://happy.example.com", probe = { ServerProbe.HappyServer }, onSave = {}, onReset = {}, onBack = {})
        }
        val card = rule.node(ItemGroupTags.CARD).bounds
        assertDp("card left", 16, card.left)
        assertDp("card top (header + 16 spacer)", 64 + 16, card.top)
        val form = rule.node(ServerTags.FORM).bounds
        assertDp("form inset 16 from the card", card.left + hairline() + 16.dp, form.left)
        assertDp("form top inset 12 from the card", card.top + hairline() + 12.dp, form.top)
        val label = rule.node(ServerTags.LABEL).bounds
        val input = rule.node(ServerTags.INPUT).bounds
        assertDp("input top", label.bottom + 8.dp, input.top)
        assertDp("input left", form.left, input.left)
        assertDp("input width", form.right - form.left, input.right - input.left)
        assertTrue("input at least 44 high", input.bottom - input.top >= 44.dp)
        val save = rule.node(ServerTags.SAVE).bounds
        assertBox("save", save, form.left, input.bottom + 8.dp + 4.dp, form.right - form.left, 44.dp)
        val reset = rule.node(ServerTags.RESET).bounds
        assertBox("reset", reset, form.left, save.bottom + 4.dp, form.right - form.left, 44.dp)
        val status = rule.node(ServerTags.STATUS).bounds
        assertDp("status top", reset.bottom + 12.dp, status.top)
        assertDp("form bottom", status.bottom, form.bottom)
    }

    @Test
    fun serverRejectsANonHttpUrlInline() {
        var saved: String? = null
        rule.setHappyContent {
            ServerScreen(customUrl = null, probe = { ServerProbe.HappyServer }, onSave = { saved = it }, onReset = {}, onBack = {})
        }
        rule.onAllNodesWithTag(ServerTags.RESET, useUnmergedTree = true).assertCountEquals(0)
        rule.node(ServerTags.INPUT).performTextReplacement("ftp://happy.example.com")
        rule.node(ServerTags.SAVE).performClick()
        rule.node(ServerTags.ERROR).assertIsDisplayed()
        rule.onNodeWithText("Server URL must use HTTP or HTTPS protocol").assertIsDisplayed()
        val input = rule.node(ServerTags.INPUT).bounds
        val error = rule.node(ServerTags.ERROR).bounds
        assertDp("error under the input", input.bottom + 8.dp, error.top)
        assertDp("save under the error", error.bottom + 12.dp + 4.dp, rule.node(ServerTags.SAVE).bounds.top)
        assertEquals(null, saved)
    }

    @Test
    fun serverSavesAfterTheProbeAndConfirmation() {
        var saved: String? = null
        rule.setHappyContent {
            ServerScreen(customUrl = null, probe = { ServerProbe.HappyServer }, onSave = { saved = it }, onReset = {}, onBack = {})
        }
        rule.node(ServerTags.INPUT).performTextReplacement("https://happy.example.com")
        rule.node(ServerTags.SAVE).performClick()
        rule.onNodeWithText("Continue with this server?").assertIsDisplayed()
        rule.onNodeWithText("Continue").performClick()
        assertEquals("https://happy.example.com", saved)
    }

    @Test
    fun settingsAppCard() {
        rule.setHappyContent { SettingsScreen(versionName = "0.1.0", onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}) }
        val card = rule.node(SettingsTags.APP_CARD).bounds
        assertBox("card", card, 16.dp, (64 + 16).dp, (PHONE_WIDTH - 32).dp, (24 + 90 + 12 + 24).dp)
        assertBox("logotype", rule.node(SettingsTags.LOGOTYPE).bounds, (16 + (PHONE_WIDTH - 32 - 300) / 2f).dp, (64 + 16 + 24).dp, 300.dp, 90.dp)
        val featuresHeader = rule.onAllNodesWithTag(ItemGroupTags.HEADER, useUnmergedTree = true)[0].bounds
        assertDp("features group follows the card", card.bottom, featuresHeader.top)
        rule.onNodeWithText("0.1.0").assertIsDisplayed()
    }

    @Test
    fun accountSecretKeyRevealAndAnalyticsSwitch() {
        var optOut = false
        rule.setHappyContent {
            AccountScreen(
                anonId = "0123456789abcdef",
                publicId = "cmabc",
                formattedSecretKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK-LLLLL-M",
                analyticsOptOut = optOut,
                onAnalyticsOptOutChange = { optOut = it },
                onLogout = {},
                onBack = {},
            )
        }
        rule.onAllNodesWithTag(AccountTags.SECRET_KEY, useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("Secret Key").performClick()
        val block = rule.node(AccountTags.SECRET_KEY).bounds
        val text = rule.node(AccountTags.SECRET_KEY_TEXT).bounds
        assertDp("secret text inset 16", block.left + 16.dp, text.left)
        assertDp("14 under the secret text", text.bottom + 14.dp, block.bottom)
        assertDp("secret text lines are 20", 0f.dp, ((text.bottom - text.top).value % 20f).dp)

        rule.node(AccountTags.ANALYTICS_SWITCH).assertIsOn().performClick()
        assertTrue("switching analytics off opts out", optOut)
    }

    @Test
    fun accountAnalyticsSwitchShowsOptOut() {
        rule.setHappyContent {
            AccountScreen(
                anonId = null, publicId = null, formattedSecretKey = "",
                analyticsOptOut = true, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {},
            )
        }
        rule.node(AccountTags.ANALYTICS_SWITCH).assertIsOff()
        rule.onAllNodesWithText("Not available").assertCountEquals(2)
    }

    @Test
    fun appearanceCyclesTheTheme() {
        var theme = ThemePreference.Adaptive
        rule.setHappyContent { AppearanceScreen(theme = theme, onThemeChange = { theme = it }, onBack = {}) }
        rule.onNodeWithText("Adaptive").assertIsDisplayed()
        val row = rule.node(ItemTags.ROW).bounds
        assertDp("theme row: icon, title and subtitle", 76, row.bottom - row.top)
        rule.node(ItemTags.ROW).performClick()
        assertEquals(ThemePreference.Light, theme)
    }

    private fun hairline() = (1f / 3f).dp
}
