package com.slopus.happy.ui.documents

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The formatting bar as iOS's `DocumentToolbarLayout` lays it out, lit for the selection. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class DocumentToolbarTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun theStripScrollsBesideTheHideKeyboardButton() {
        rule.setHappyContent { DocumentToolbar(emptySet(), {}, {}, {}) }
        val bar = rule.node(DocumentToolbarTags.BAR).bounds
        assertBox("bar", bar, 0.dp, 0.dp, 411.dp, 56.dp)
        val done = rule.node(DocumentToolbarTags.DONE).bounds
        // 44 in a capsule with 4 inside it, 8 from the edge.
        assertBox("done", done, 411.dp - 8.dp - 4.dp - 44.dp, 6.dp, 44.dp, 44.dp)
        val strip = rule.node(DocumentToolbarTags.STRIP).bounds
        assertDp("strip from the edge", 8.dp, strip.left)
        assertDp("strip height", 52.dp, strip.bottom - strip.top)
        assertDp("8 between the capsules", 8.dp, done.left - 4.dp - strip.right)
        val style = rule.node(DocumentToolbarTags.STYLE).bounds
        val bold = rule.node(DocumentToolbarTags.tool(DocumentTool.Bold)).bounds
        assertBox("style", style, 12.dp, 6.dp, 44.dp, 44.dp)
        assertDp("2 between buttons", 2.dp, bold.left - style.right)
    }

    @Test
    fun aToolTheSelectionHasIsLitAndATapRunsIt() {
        val ran = ArrayList<DocumentTool>()
        rule.setHappyContent(dark = true) { DocumentToolbar(setOf(DocumentTool.Italic), { ran += it }, {}, {}) }
        rule.node(DocumentToolbarTags.tool(DocumentTool.Italic)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        rule.node(DocumentToolbarTags.tool(DocumentTool.Bold)).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        rule.node(DocumentToolbarTags.tool(DocumentTool.Bold)).performClick()
        assertEquals(listOf(DocumentTool.Bold), ran)
    }

    @Test
    fun theStyleMenuPicksTextOrAHeading() {
        val picked = ArrayList<Int>()
        rule.setHappyContent { DocumentToolbar(emptySet(), {}, { picked += it }, {}) }
        rule.node(DocumentToolbarTags.STYLE).performClick()
        rule.onNodeWithText("Heading 2").performClick()
        rule.node(DocumentToolbarTags.STYLE).performClick()
        rule.onNodeWithText("Text").performClick()
        assertEquals(listOf(2, 0), picked)
    }
}
