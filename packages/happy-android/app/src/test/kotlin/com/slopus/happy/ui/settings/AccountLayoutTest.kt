package com.slopus.happy.ui.settings

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccountLayoutTest {
    @get:Rule
    val rule = createComposeRule()

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
}
