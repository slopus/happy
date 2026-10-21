package com.slopus.happy.ui.settings

import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.payments.Paywall
import com.slopus.happy.payments.PaywallOutcome
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
            SettingsScreen("1", {}, {}, {}, {}, isPro = true, onSupport = { error("Pro row must be inert") })
        }
        val terminal = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[0].bounds
        val card = rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true)[1].bounds
        val support = rule.node(SettingsTags.SUPPORT).bounds
        assertDp("16 under terminal group", terminal.bottom + 16.dp, card.top)
        assertBox("support card", card, 16.dp, card.top, (PHONE_WIDTH - 32).dp, (76 + 2f / 3).dp)
        assertBox("support row", support, (16 + 1f / 3).dp, card.top + (1f / 3).dp, (PHONE_WIDTH - 32 - 2f / 3).dp, 76.dp)
        rule.node(SettingsTags.SUPPORT).assertHasNoClickAction()
        rule.onNodeWithText("Thank you for your support!").assertIsDisplayed()
    }

    @Test fun missingKeyShowsLocalizedFailureAndPassesVoluntarySupportFlow() {
        var seenFlow: String? = null
        val paywall = object : Paywall {
            override fun hasPro() = false
            override suspend fun present(flow: String?): PaywallOutcome {
                seenFlow = flow
                return PaywallOutcome(false, error = "RevenueCat not initialized")
            }
        }
        rule.setHappyContent {
            val alerts = remember { Alerts() }
            val support = rememberSupportAction(paywall, errorAlert(alerts))
            SettingsScreen("1", {}, {}, {}, {}, isPro = false, onSupport = support::run)
            alerts.Host()
        }
        rule.onNodeWithText("Support us").performScrollTo().performClick()
        rule.onNodeWithText("Purchases are unavailable right now. Please try again later.").assertIsDisplayed()
        rule.onNodeWithText("Error").assertIsDisplayed()
        assertEquals("voluntary_support", seenFlow)
    }

    @Test fun cancellationDoesNotShowError() {
        val paywall = object : Paywall {
            override fun hasPro() = false
            override suspend fun present(flow: String?) = PaywallOutcome(success = true)
        }
        var errors = 0
        rule.setHappyContent {
            val support = rememberSupportAction(paywall) { errors++ }
            SettingsScreen("1", {}, {}, {}, {}, onSupport = support::run)
        }
        rule.onNodeWithText("Support us").performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(0, errors)
    }
}