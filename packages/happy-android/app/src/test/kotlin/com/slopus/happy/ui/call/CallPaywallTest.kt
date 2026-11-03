package com.slopus.happy.ui.call

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.call.CallOffer
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The voice paywall ([CallPaywall]): what is used, when it comes back, and nothing on sale that can be bought. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CallPaywallTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun itSaysWhenFreeTimeIsBackAndSellsNothing() {
        rule.setHappyContent { CallPaywall(freeAgain = System.currentTimeMillis() + 3_600_000, offer = CallOffer.Unavailable, onDismiss = {}) }
        rule.waitForIdle()
        rule.onNodeWithText("Free voice time used", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("More free time at", substring = true, useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Not available yet", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Voice subscriptions aren’t on sale yet. Nothing can be bought here for now.", useUnmergedTree = true).assertExists()
        // The offer is a row that says so, not a button.
        assertFalse(rule.node(CallPaywallTags.OFFER).fetchSemanticsNode().config.contains(SemanticsActions.OnClick))
    }

    @Test
    fun withNoTimeComingBackItSaysNoTime() {
        rule.setHappyContent { CallPaywall(freeAgain = null, offer = CallOffer.Unavailable, onDismiss = {}) }
        rule.waitForIdle()
        rule.onNodeWithText("Free voice time used", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("More free time at", substring = true, useUnmergedTree = true).assertDoesNotExist()
    }
}
