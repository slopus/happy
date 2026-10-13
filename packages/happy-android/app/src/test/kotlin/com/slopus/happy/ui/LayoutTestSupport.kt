package com.slopus.happy.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals

/**
 * Layout tests run on a 411x891 dp phone at density 3 (xxhdpi), so every
 * whole-dp spec value is a whole number of pixels and can be compared
 * exactly. [TOLERANCE] absorbs only sub-pixel rounding.
 */
const val PHONE = "w411dp-h891dp-xxhdpi"
const val PHONE_WIDTH = 411
val TOLERANCE = 0.34.dp

fun ComposeContentTestRule.setHappyContent(dark: Boolean = false, content: @Composable () -> Unit) {
    setContent {
        HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light, content = content)
    }
}

/** The node with [tag], looked up in the unmerged tree so tags inside clickable rows are found. */
fun ComposeContentTestRule.node(tag: String): SemanticsNodeInteraction = onNodeWithTag(tag, useUnmergedTree = true)

/** Bounds in the root, in dp, unaffected by clipping. */
val SemanticsNodeInteraction.bounds: DpRect get() = getUnclippedBoundsInRoot()

fun assertDp(message: String, expected: Dp, actual: Dp) {
    assertEquals(message, expected.value, actual.value, TOLERANCE.value)
}

fun assertDp(message: String, expected: Int, actual: Dp) = assertDp(message, expected.dp, actual)

/** Checks one node's box: left, top, width, height. */
fun assertBox(name: String, rect: DpRect, left: Dp, top: Dp, width: Dp, height: Dp) {
    assertDp("$name left", left, rect.left)
    assertDp("$name top", top, rect.top)
    assertDp("$name width", width, rect.width)
    assertDp("$name height", height, rect.height)
}
