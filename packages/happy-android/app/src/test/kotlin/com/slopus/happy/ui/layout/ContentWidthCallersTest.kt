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
 * The content column ([ContentTokens]) through the real modifier and a real
 * caller ([ItemGroup], which every settings page is made of), not through
 * the formula: a compact window is untouched, a medium one gets the 24
 * margin and the 640 measure, an expanded one the 800 column.
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
    fun onItsSideAPhoneIsMediumAndHeldToTheMeasure() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { Capped() }
        }
        val box = rule.node(TAG).bounds
        assertDp("held to the medium column", ContentTokens.Medium.columnMaxWidth, box.width)
        assertDp("centred", (731.dp - ContentTokens.Medium.columnMaxWidth) / 2, box.left)
    }

    /**
     * iOS's b73b1accd: on its side a phone's cutout and a side navigation bar are unsafe, and
     * the column keeps out of them (48 on the left, 48 on the right here, the medium column's 8 gutter less);
     * where the gutter is more, the gutter holds.
     */
    @Test
    @Config(qualifiers = "w731dp-h411dp-xxhdpi")
    fun theColumnKeepsOutOfTheUnsafeSides() {
        rule.setHappyContent {
            val sides = WindowLayout.of(731.dp, 411.dp, safeLeft = 48.dp, safeRight = 24.dp)
            androidx.compose.runtime.CompositionLocalProvider(LocalWindowLayout provides sides) { Capped() }
        }
        val box = rule.node(TAG).bounds
        // 731 - 48 - 24 leaves 659 < 672: the cutout and the bar bind on both sides.
        assertDp("what is left between them", 659, box.width)
        assertDp("clear of the cutout", 48, box.left)
        assertDp("clear of the side bar", 731 - 24, box.right)
    }

    @Test
    @Config(qualifiers = "w891dp-h411dp-xxhdpi")
    fun theColumnCentresInTheSafeBand() {
        rule.setHappyContent {
            val sides = WindowLayout.of(891.dp, 411.dp, safeLeft = 30.dp, safeRight = 0.dp)
            androidx.compose.runtime.CompositionLocalProvider(LocalWindowLayout provides sides) { Capped() }
        }
        val box = rule.node(TAG).bounds
        assertDp("the 800 column", 800, box.width)
        // The band is 30 (the cutout) to 891 - 8 (the gutter): 853, the 800 centred in it.
        assertDp("centred in the safe band", 56.5.dp, box.left)
    }

    @Test
    @Config(qualifiers = "w640dp-h800dp-xxhdpi")
    fun aNarrowMediumWindowKeepsTheMargin() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { Capped() }
        }
        val box = rule.node(TAG).bounds
        // The column's own 16 inset makes the 24 margin: 8 of gutter each side.
        assertDp("the gutter", 8, box.left)
        assertDp("the rest", 640 - 16, box.width)
    }

    @Test
    @Config(qualifiers = "w900dp-h731dp-xxhdpi")
    fun pastTheCapTheColumnIsHeldAndCentred() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { Capped() }
        }
        val box = rule.node(TAG).bounds
        assertDp("held to the cap", ContentTokens.Expanded.columnMaxWidth, box.width)
        assertDp("centred", (900.dp - ContentTokens.Expanded.columnMaxWidth) / 2, box.left)
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
        assertTrue("the row is held to the cap, not the window: $row", row.width > (ContentTokens.Expanded.columnMaxWidth - 34.dp) && row.width <= ContentTokens.Expanded.columnMaxWidth - 32.dp)
        assertTrue("and centred in the 900 window", row.left > 60.dp)
    }
}
