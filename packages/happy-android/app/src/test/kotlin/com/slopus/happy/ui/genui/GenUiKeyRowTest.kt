package com.slopus.happy.ui.genui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.genui.GenUi
import com.slopus.happy.genui.RenderDocument
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import kotlin.math.abs

/**
 * A key beside its `fixed` value (iOS 9baa638ee, baa0587ed): side by side
 * while the key keeps its widest piece between breaks, else the key over
 * the value at the start, 2 apart; a row without `fixed` text only
 * squeezes, as before. An identifier breaks at its `_`s only in a column
 * too narrow for it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiKeyRowTest {
    @get:Rule val rule = createComposeRule()

    private fun row(key: String, value: String, fixed: Boolean): RenderDocument = GenUi.parse(
        """{"genuiRender":1,"compiler":"test","root":"row","elements":{
          "row":{"type":"box","props":{"role":"item","direction":"row","gap":"inline","align":"baseline","leading":"none"},"children":["texts","value"]},
          "texts":{"type":"box","props":{"grow":true},"children":["key"]},
          "key":{"type":"text","props":{"spans":[{"text":"$key"}],"role":"label"}},
          "value":{"type":"text","props":{"spans":[{"text":"$value"}],"role":"body","align":"end","fixed":$fixed}}}}""",
    )

    private var shown by mutableStateOf<Pair<RenderDocument, Dp>?>(null)

    private fun show(document: RenderDocument, width: Dp) {
        if (shown == null) {
            shown = document to width
            rule.setHappyContent { shown?.let { (d, w) -> Box(Modifier.requiredWidth(w)) { GenUiView(d) } } }
        } else {
            rule.runOnIdle { shown = document to width }
        }
        rule.waitForIdle()
    }

    /** Where the placed text reading [words] (as written) is. */
    private fun bounds(words: String): Rect {
        val found = ArrayList<Rect>()
        fun walk(node: SemanticsNode) {
            val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }?.replace("\u200B", "")
            if (text == words && node.layoutInfo.isPlaced) found += node.boundsInRoot
            node.children.forEach(::walk)
        }
        walk(rule.onRoot(useUnmergedTree = true).fetchSemanticsNode())
        assertEquals("one placed \"$words\"", 1, found.size)
        return found.single()
    }

    @Test fun aKeyThatFitsBesideItsFixedValueStaysBesideIt() {
        show(row("STRIPE_SECRET_KEY", "Secret key", fixed = true), 360.dp)
        val (key, value) = bounds("STRIPE_SECRET_KEY") to bounds("Secret key")
        assertTrue("beside: $key $value", value.left >= key.right)
        assertTrue("on one line", abs(value.top - key.top) < key.height)
    }

    @Test fun aKeyTooNarrowBesideItsFixedValueGoesAboveIt() {
        show(row("STRIPE_WEBHOOK_SECRET", "Signing secret of the webhook endpoint", fixed = true), 360.dp)
        val (key, value) = bounds("STRIPE_WEBHOOK_SECRET") to bounds("Signing secret of the webhook endpoint")
        assertTrue("above: $key $value", value.top >= key.bottom)
        assertEquals("both at the start", key.left, value.left, 0.5f)
        val gap = with(rule.density) { KeyRowStackGap.toPx() }
        assertEquals("2 apart", gap, value.top - key.bottom, 1f)
        // Wide enough, side by side again.
        show(row("STRIPE_WEBHOOK_SECRET", "Signing secret of the webhook endpoint", fixed = true), 700.dp)
        val (wideKey, wideValue) = bounds("STRIPE_WEBHOOK_SECRET") to bounds("Signing secret of the webhook endpoint")
        assertTrue("beside: $wideKey $wideValue", wideValue.left >= wideKey.right)
    }

    @Test fun aRowWithoutFixedTextOnlySqueezes() {
        show(row("STRIPE_WEBHOOK_SECRET", "Signing secret of the webhook endpoint", fixed = false), 360.dp)
        val (key, value) = bounds("STRIPE_WEBHOOK_SECRET") to bounds("Signing secret of the webhook endpoint")
        assertTrue("beside: $key $value", value.left >= key.right)
        assertTrue("on one line: $key $value", value.top < key.bottom)
    }

    /** 13-secret at a phone's width: the key that keeps its widest piece stays beside its value; the one that doesn't goes above. */
    @Test fun thirteenSecretOnAPhone() {
        show(GenUi.parse(File("src/debug/assets/genui/fixtures/13-secret.json").readText()), 375.dp)
        val (key0, value0) = bounds("STRIPE_SECRET_KEY") to bounds("Secret key, starts with sk_test_")
        assertTrue("STRIPE_SECRET_KEY beside its value: $key0 $value0", value0.left >= key0.right)
        val (key1, value1) = bounds("STRIPE_WEBHOOK_SECRET") to bounds("Signing secret of the webhook endpoint")
        assertTrue("STRIPE_WEBHOOK_SECRET above its value: $key1 $value1", value1.top >= key1.bottom)
        assertEquals(key1.left, value1.left, 0.5f)
    }

    @Test fun anIdentifierBreaksAtItsUnderscoresOnly() {
        assertEquals("STRIPE_\u200BSECRET_\u200BKEY", breakable("STRIPE_SECRET_KEY"))
        assertEquals("_private a__b c_ 1_\u200B2", breakable("_private a__b c_ 1_2"))
        assertEquals(listOf("STRIPE_SECRET_KEY"), identifiers(listOf(com.slopus.happy.genui.Span("Set "), com.slopus.happy.genui.Span("STRIPE_SECRET_KEY", code = true))))
    }
}
