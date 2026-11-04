package com.slopus.happy.ui.settings

import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ApplicationProvider
import com.slopus.happy.R
import com.slopus.happy.payments.CallIntro
import com.slopus.happy.payments.FakeRevenueCat
import com.slopus.happy.payments.FakeStore
import com.slopus.happy.payments.Offers
import com.slopus.happy.payments.Subscription
import com.slopus.happy.ui.call.OfferHost
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import androidx.compose.ui.test.onAllNodesWithTag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SupportUsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun supportRowMatchesNativeSpecAndProRowHasNoAction() {
        rule.setHappyContent {
            SettingsScreen(SettingsFixtures.profile, AboutInfo("1", isPro = true), aboutActions = AboutActions(onSupport = { error("Pro row must be inert") }))
        }
        rule.node(SettingsTags.SUPPORT).performScrollTo()
        // After the header and the accounts, Account, look and terminal cards: the fifth.
        val terminal = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[3].bounds
        val card = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[4].bounds
        val support = rule.node(SettingsTags.SUPPORT).bounds
        assertDp("16 under the terminal card", terminal.bottom + 16.dp, card.top)
        assertBox("support card", card, 16.dp, card.top, (PHONE_WIDTH - 32).dp, (76 + 64 + 2f / 3).dp)
        assertBox("support row", support, (16 + 1f / 3).dp, card.top + (1f / 3).dp, (PHONE_WIDTH - 32 - 2f / 3).dp, 76.dp)
        rule.node(SettingsTags.SUPPORT).assertHasNoClickAction()
        rule.onNodeWithText("Thank you for your support!").assertIsDisplayed()
    }

    /** Support us pushes Support Happy's page ([com.slopus.happy.ui.connection.SupportRoute]); no offer sheet comes up. */
    @Test fun supportPushesTheSupportPage() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val scope = MainScope()
        val subscription = Subscription(scope, FakeStore(), FakeRevenueCat(), context.getSharedPreferences("support-us-subscription", Context.MODE_PRIVATE))
        val offers = Offers(scope, subscription, CallIntro(context.getSharedPreferences("support-us-intro", Context.MODE_PRIVATE)))
        var pushed = 0
        try {
            rule.setHappyContent {
                SettingsScreen(SettingsFixtures.profile, AboutInfo("1"), aboutActions = AboutActions(onSupport = { pushed++ }))
                OfferHost(offers)
            }
            rule.onNodeWithText("Support us").performScrollTo().performClick()
            rule.waitForIdle()
            assertEquals(1, pushed)
            assertNull(offers.sheet.value)
            rule.onAllNodesWithText("Error").assertCountEquals(0)
        } finally {
            scope.cancel()
        }
    }
}