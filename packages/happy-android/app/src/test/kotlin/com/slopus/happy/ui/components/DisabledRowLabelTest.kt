package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.NEEDS_RELOGIN_NAME
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A row that can't be picked says why, in full: the computer an old Happy
 * CLI linked was cut to "Computer with an old Happy CLI si…" in the
 * compose chat's computer menu and the new-session picker. Its label wraps
 * to a second line there; a row that can be picked keeps one.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DisabledRowLabelTest {
    @get:Rule
    val rule = createComposeRule()

    private fun layout(text: String): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        rule.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
        return results.single()
    }

    @Test
    fun aMenuRowThatCantBePickedWrapsItsLabel() {
        rule.setHappyContent {
            Box(Modifier.width(240.dp)) {
                HappyMenuItem(NEEDS_RELOGIN_NAME, onClick = {}, supporting = "Run happy auth login --force on it", enabled = false, labelLines = 2)
            }
        }
        val label = layout(NEEDS_RELOGIN_NAME)
        assertEquals(2, label.lineCount)
        assertFalse("cut", label.isLineEllipsized(label.lineCount - 1))
    }

    @Test
    fun aPickerRowThatCantBePickedWrapsItsLabel() {
        rule.setHappyContent {
            Box(Modifier.width(240.dp)) {
                PickerSheetOption("old", NEEDS_RELOGIN_NAME, "Run happy auth login --force on it", selected = false, onClick = {}, disabled = true)
            }
        }
        val label = layout(NEEDS_RELOGIN_NAME)
        assertEquals(2, label.lineCount)
        assertFalse("cut", label.isLineEllipsized(label.lineCount - 1))
    }
}
