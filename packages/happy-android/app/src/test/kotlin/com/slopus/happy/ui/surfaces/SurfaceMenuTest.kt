package com.slopus.happy.ui.surfaces

import androidx.compose.foundation.layout.Row
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SurfaceMenuTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun leaveHasA48DpTargetAndWaitsForConfirmation() {
        var leaves = 0
        var backs = 0
        rule.setHappyContent { Row { SurfaceLeaveMenu("Plan", { backs++ }) { leaves++; null } } }
        val bounds = rule.node("surface.more").getUnclippedBoundsInRoot()
        assertDp("More width", 48.dp, bounds.right - bounds.left)
        assertDp("More height", 48.dp, bounds.bottom - bounds.top)
        rule.node("surface.more").performClick()
        rule.onNodeWithText("Leave").performClick()
        rule.onNodeWithText("Leave “Plan”?").assertExists()
        assertEquals(0, leaves)
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(0, leaves)
        rule.node("surface.more").performClick()
        rule.onNodeWithText("Leave").performClick()
        rule.onNodeWithText("Leave").performClick()
        rule.waitForIdle()
        assertEquals(1, leaves)
        assertEquals(1, backs)
    }

    @Test
    fun aRefusalKeepsTheScreenAndSaysWhy() {
        var backs = 0
        rule.setHappyContent(dark = true) { Row { SurfaceLeaveMenu("Plan", { backs++ }) { "The owner must stay." } } }
        rule.node("surface.more").performClick()
        rule.onNodeWithText("Leave").performClick()
        rule.onNodeWithText("Leave").performClick()
        rule.onNodeWithText("The owner must stay.").assertExists()
        assertEquals(0, backs)
    }
}