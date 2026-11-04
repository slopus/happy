package com.slopus.happy.ui.surfaces

import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A Surface the phone doesn't open, and one the computer doesn't know, laid out as iOS's `EmptyLayout`. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SurfaceElsewhereTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun elsewhereIsTheSeedlingOverTheLineCentredUnderTheBar() {
        rule.setHappyContent { SurfaceElsewhere("Week", onBack = {}) }
        rule.onNodeWithText("Week").assertExists()
        rule.onNodeWithText("Open this on your computer to use it.").assertExists()
        val mark = rule.node(SurfaceTags.EMPTY_MARK).getUnclippedBoundsInRoot()
        val text = rule.node(SurfaceTags.EMPTY_TEXT).getUnclippedBoundsInRoot()
        val page = rule.node(SurfaceTags.EMPTY).getUnclippedBoundsInRoot()
        assertDp("mark", 64.dp, mark.right - mark.left)
        assertDp("mark height", 64.dp, mark.bottom - mark.top)
        assertDp("mark centred", (411.dp - 64.dp) / 2, mark.left)
        assertDp("20 between", 20.dp, text.top - mark.bottom)
        // The line: 24 in from each side of the phone, at most 360 wide.
        assertDp("line width", 360.dp, text.right - text.left)
        assertDp("line centred", (411.dp - 360.dp) / 2, text.left)
        // The block sits in the middle of the page under the bar.
        val above = mark.top - page.top
        val below = page.bottom - text.bottom
        assertDp("centred", above, below)
    }

    @Test
    fun aSurfaceIsReadWhileTheCatalogIsNot() {
        rule.setHappyContent(dark = true) { SurfaceMissing("Plan", loading = true, onBack = {}) }
        rule.node(PlaceTags.LOADER).assertExists()
    }

    @Test
    fun aSurfaceTheComputerDoesntKnowSaysSo() {
        rule.setHappyContent { SurfaceMissing("Plan", loading = false, onBack = {}) }
        rule.onNodeWithText("This isn’t here. It may belong to a Happy Agent this one can’t reach.").assertExists()
    }
}
