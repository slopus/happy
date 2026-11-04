package com.slopus.happy.ui.camera

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoCameraLayoutTest {
    @get:Rule val rule = createComposeRule()

    @Composable
    private fun Camera(
        motion: PhotoMotion = PhotoMotion(settled = true),
        problem: PhotoProblem? = null,
        review: AttachmentPreview? = null,
        tile: () -> Rect? = { null },
        take: () -> Unit = {},
        settings: () -> Unit = {},
        use: () -> Unit = {},
        preview: @Composable () -> Unit = { Box(Modifier.fillMaxSize().background(Color.DarkGray)) },
    ) {
        PhotoCameraLayout(
            full = true, motion = motion, tile = tile, ready = problem == null, busy = false,
            problem = problem, review = review, firstFrame = { 1f }, blink = { 0f },
            onOpen = {}, onBack = {}, onTake = take, onRetake = {}, onUse = use,
            onSettings = settings, onRetry = {}, preview = preview,
        )
    }

    @Test
    fun thePhoneHasTheStandardHeaderAndPhotoFrameAboveTheShutter() {
        var shots = 0
        rule.setHappyContent { ProvideWindowLayout { Camera(take = { shots++ }) } }
        assertDp("standard header", 64, rule.node(HeaderTags.BAR).bounds.height)
        val photo = rule.node(PhotoTags.PREVIEW).bounds
        assertDp("preview under the header", rule.node(HeaderTags.BAR).bounds.bottom, photo.top)
        assertDp("photo width", 411, photo.width)
        assertDp("4:3 portrait", 548, photo.height)
        assertDp("shutter target", 96, rule.node(PhotoTags.SHUTTER).bounds.width)
        assertDp("ring", 68, rule.node(PhotoTags.RING).bounds.width)
        assertDp("disc", 60, rule.node(PhotoTags.DISC).bounds.width)
        rule.node(PhotoTags.SHUTTER).performClick()
        assertEquals(1, shots)
    }

    @Test
    fun cameraRefusalOffersSettingsAndCannotTakeAPhoto() {
        var settings = 0
        rule.setHappyContent { ProvideWindowLayout { Camera(problem = PhotoProblem.Permission, settings = { settings++ }) } }
        rule.node(PhotoTags.SHUTTER).assertIsNotEnabled()
        rule.node(PhotoTags.MESSAGE).assertIsDisplayed()
        rule.onNodeWithText("Open Settings").performClick()
        assertEquals(1, settings)
    }

    @Test
    fun reviewFitsTheWholePhotoAndOffersUsePhotoInTheNinetySixBar() {
        var used = 0
        val photo = AttachmentPreview("photo", "file:///camera-review.jpg", 3072, 2304, "image/jpeg", 1000, "photo.jpg")
        rule.setHappyContent { ProvideWindowLayout { Camera(review = photo, use = { used++ }) } }
        val image = rule.node(PhotoTags.REVIEW).bounds
        val bar = rule.node(PhotoTags.REVIEW_BAR).bounds
        assertDp("review bar", 96, bar.height)
        assertDp("whole image", image.width * 3 / 4, image.height)
        assertTrue("image above the controls", image.bottom <= bar.top)
        rule.node(PhotoTags.SHUTTER).assertDoesNotExist()
        rule.node(PhotoTags.RETAKE).assertIsDisplayed()
        rule.node(PhotoTags.USE).performClick()
        assertEquals(1, used)
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun tabletKeepsItsControlsInTheTrailingColumn() {
        rule.setHappyContent { ProvideWindowLayout { Camera() } }
        val shutter = rule.node(PhotoTags.SHUTTER).bounds
        val photo = rule.node(PhotoTags.PREVIEW).bounds
        assertTrue("120 column", shutter.left >= 1160.dp && shutter.right <= 1280.dp)
        assertTrue("preview beside controls", photo.right <= 1160.dp)
        assertDp("landscape 4:3", photo.height * 4 / 3, photo.width)
        assertDp("target", 96, shutter.width)
    }

    @Test
    fun theTileMorphDoesNotRemeasureTheRetainedPreview() {
        rule.mainClock.autoAdvance = false
        val motion = PhotoMotion()
        lateinit var scope: CoroutineScope
        var measures = 0
        rule.setHappyContent {
            ProvideWindowLayout {
                scope = rememberCoroutineScope()
                val density = LocalDensity.current
                val tile = with(density) { Rect(2.dp.toPx(), 360.dp.toPx(), 136.dp.toPx(), 630.dp.toPx()) }
                Camera(motion = motion, tile = { tile }, preview = {
                    Box(Modifier.fillMaxSize().layout { measurable, constraints ->
                        measures++
                        val placeable = measurable.measure(constraints)
                        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
                    }.background(Color.Magenta))
                })
            }
        }
        rule.mainClock.advanceTimeByFrame()
        val before = measures
        scope.launch { motion.open(tile = true, reduce = false) }
        Snapshot.sendApplyNotifications()
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        assertEquals("the preview is transformed, not measured each frame", before, measures)
        assertDp("full photo", 411, rule.node(PhotoTags.PREVIEW).bounds.width)
    }
}
