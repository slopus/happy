package com.slopus.happy.ui.genui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.genui.GenUi
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * A secret button before and after its form saved (iOS 4f36d0b23): it
 * leads with a glyph, a lock where it names none, which turns to a check;
 * its label, frame and border stay, and TalkBack hears "Saved".
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiSavedButtonTest {
    @get:Rule val rule = createComposeRule()

    private fun glyphs(name: String) = rule.onAllNodesWithTag(GenUiTags.GLYPH + name, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun document(icon: String?): com.slopus.happy.genui.RenderDocument {
        val text = File("src/debug/assets/genui/fixtures/13-secret.json").readText()
        // 13-secret's button names the lock; without it the button draws one all the same.
        return GenUi.parse(if (icon == null) text.replace("\"icon\": \"lock\",\n        \"variant\"", "\"variant\"") else text)
    }

    private fun check(icon: String?) {
        val doc = document(icon)
        assertEquals(icon, (doc.elements["add-stripe"] as com.slopus.happy.genui.Element.Button).icon?.name?.lowercase())
        val state = GenUiState()
        rule.setHappyContent { Box(Modifier.requiredWidth(375.dp)) { GenUiView(doc, state = state) } }
        val button = rule.onNode(hasText("Add Stripe keys") and hasClickAction())
        val before: Rect = button.fetchSemanticsNode().boundsInRoot
        assertEquals(1, glyphs("Lock"))
        assertEquals(0, glyphs("Check"))
        assertNull(button.fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))
        val shot = button.captureToImage()

        rule.runOnIdle { state.save("add-stripe", "stripe") }
        rule.waitForIdle()
        assertEquals(0, glyphs("Lock"))
        assertEquals(1, glyphs("Check"))
        assertEquals("the same place and size", before, button.fetchSemanticsNode().boundsInRoot)
        assertEquals("Saved", button.fetchSemanticsNode().config.getOrNull(SemanticsProperties.StateDescription))
        assertEquals(listOf("Add Stripe keys"), button.fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text)?.map { it.text })
        // The colours stay: outside the glyph, the button's pixels are the same as before.
        val after = button.captureToImage()
        val (a, b) = shot.toPixelMap() to after.toPixelMap()
        val glyph = rule.onNode(androidx.compose.ui.test.hasTestTag(GenUiTags.GLYPH + "Check"), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        var differ = 0
        for (x in 0 until a.width) for (y in 0 until a.height) {
            val inGlyph = glyph.contains(androidx.compose.ui.geometry.Offset(before.left + x, before.top + y))
            if (!inGlyph && a[x, y] != b[x, y]) differ++
        }
        assertEquals("nothing but the glyph changed", 0, differ)
    }

    @Test fun aSecretButtonNamingItsGlyphTurnsItToACheck() = check(icon = "lock")

    @Test fun aSecretButtonNamingNoGlyphLeadsWithALockThatTurnsToACheck() = check(icon = null)
}
