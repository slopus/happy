package com.slopus.happy.ui.camera

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.test.click
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhotoGesturesTest {
    @get:Rule val rule = createComposeRule()

    @Test fun holdAndTapRemainDistinctAndPinchKeepsRunningThroughZoomRecomposition() {
        val focus = mutableListOf<Boolean>()
        var zoom by mutableFloatStateOf(1f)
        var pan = 0f
        rule.setHappyContent {
            // Reading zoom makes every zoom update recompose this actual gesture host.
            val current = zoom
            Box(Modifier.size(200.dp).testTag("gestures").semantics { stateDescription = current.toString() }.then(photoGestures(
                onFocus = { _, lock -> focus += lock },
                onTransform = { at, factor -> if (factor != 1f) zoom = (zoom * factor).coerceIn(1f, 3f) else pan += at.y },
            )))
        }
        rule.node("gestures").performTouchInput { click(center); longClick(center, durationMillis = 650) }
        assertEquals(listOf(false, true), focus)
        rule.node("gestures").performTouchInput {
            val start = Offset(center.x * 0.15f, 0f)
            val end = Offset(center.x * 0.85f, 0f)
            pinch(start0 = center - start, end0 = center - end,
                start1 = center + start, end1 = center + end, durationMillis = 500)
        }
        assertTrue("the whole pinch reaches the3x limit", zoom > 2.8f && zoom <= 3f)
        assertEquals("a pinch never becomes a tap or hold", listOf(false, true), focus)
        rule.node("gestures").performTouchInput { swipe(center, center - Offset(0f, 100f), durationMillis = 300) }
        assertTrue("vertical drag reaches exposure", pan < -50f)
    }
}