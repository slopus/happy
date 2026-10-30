package com.slopus.happy.ui.layout

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The cap went from "a phone's longest side" to "the window's own width,
 * up to 800". Upright on a phone that changes the number — 891 to 411 —
 * and these pin down that it changes no pixels, because a cap equal to the
 * width available was never binding. Measured through the real modifier and
 * a real caller ([ItemGroup], which every settings page is made of), not
 * through the formula.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ContentWidthCallersTest {
    @get:Rule val rule = createComposeRule()

    private companion object {
        const val TAG = "capped"
        const val GROUP = "cappedGroup"
    }

    @Composable
    private fun Capped() {
        Box(Modifier.contentMaxWidth(LocalWindowLayout.current).height(20.dp).testTag(TAG))
    }

    @Test
    @Config(qualifiers = PHONE)
    fun uprightOnAPhoneNothingIsHeldIn() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { Capped() }
        }
        // 411 wide, 891 tall: the cap is now 411, was 891, and either way the row fills the window.
        assertDp("capped content fills the phone", 411, rule.node(TAG).bounds.width)
    }

    @Test
    @Config(qualifiers = "w731dp-h411dp-xxhdpi")
    fun onItsSideBelowTheCapNothingIsHeldInEither() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { Capped() }
        }
        assertDp("capped content fills the sideways phone", 731, rule.node(TAG).bounds.width)
    }

    @Test
    @Config(qualifiers = "w900dp-h731dp-xxhdpi")
    fun pastTheCapTheColumnIsHeldAndCentred() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { Capped() }
        }
        val box = rule.node(TAG).bounds
        assertDp("held to the cap", ContentWidth.tablet, box.width)
        assertDp("centred", (900.dp - ContentWidth.tablet) / 2, box.left)
    }

    /** A settings page's own container, the caller with the widest reach. */
    @Test
    @Config(qualifiers = PHONE)
    fun aSettingsGroupStillFillsThePhone() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) {
                ItemGroup { Item(title = "Appearance", modifier = Modifier.testTag(GROUP)) }
            }
        }
        // ItemGroup keeps 16 of its own air each side and a hairline border, so the row is just under window - 32.
        val row = rule.node(GROUP).bounds
        assertTrue("the row fills the phone: $row", row.width > (411 - 34).dp && row.width <= (411 - 32).dp)
    }

    @Test
    @Config(qualifiers = "w900dp-h731dp-xxhdpi")
    fun aSettingsGroupIsHeldInOnAWideWindow() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) {
                ItemGroup { Item(title = "Appearance", modifier = Modifier.testTag(GROUP)) }
            }
        }
        val row = rule.node(GROUP).bounds
        assertTrue("the row is held to the cap, not the window: $row", row.width > (ContentWidth.tablet - 34.dp) && row.width <= ContentWidth.tablet - 32.dp)
        assertTrue("and centred in the 900 window", row.left > 60.dp)
    }
}
