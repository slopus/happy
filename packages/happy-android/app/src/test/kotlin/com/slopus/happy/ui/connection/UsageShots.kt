package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.setHappyContent
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Settings › Usage at the Fold's two sizes, written only when HAPPY_SHOTS_DIR
 * is set: the cover screen (411 wide) light and dark, and the inner one.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UsageShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private fun shot(name: String, dark: Boolean, callout: Boolean = false) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        val state = UsageFixtures.ready
        rule.setHappyContent(dark) { AgentUsageScreen(state, onBack = {}, now = UsageFixtures.now, today = UsageFixtures.today) }
        rule.waitForIdle()
        // Wednesday a week ago, in the column before today's.
        if (callout) UsageFixtures.tapDay(rule, UsageFixtures.today.minusDays(7))
        val page = rule.onAllNodes(isRoot())[0].captureToImage().asAndroidBitmap().copy(Bitmap.Config.ARGB_8888, true)
        // The callout is a window of its own: drawn over the page where it sits.
        if (callout) {
            val node = rule.onNode(hasTestTag(AgentUsageTags.CALLOUT))
            val at = node.fetchSemanticsNode().positionOnScreen - rule.onAllNodes(isRoot()).fetchSemanticsNodes()[0].positionOnScreen
            android.graphics.Canvas(page).drawBitmap(node.captureToImage().asAndroidBitmap(), at.x, at.y, null)
        }
        File(dir, "$name.png").outputStream().use { page.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test @Config(qualifiers = "w411dp-h1500dp-xxhdpi")
    fun coverLight() = shot("usage-android-cover-light", dark = false)

    @Test @Config(qualifiers = "w411dp-h1500dp-xxhdpi")
    fun coverDark() = shot("usage-android-cover-dark", dark = true)

    @Test @Config(qualifiers = "w411dp-h900dp-xxhdpi")
    fun coverCallout() = shot("usage-android-cover-callout", dark = false, callout = true)

    @Test @Config(qualifiers = "w673dp-h1500dp-xhdpi")
    fun innerLight() = shot("usage-android-inner-light", dark = false)

    @Test @Config(qualifiers = "w673dp-h1500dp-xhdpi")
    fun innerDark() = shot("usage-android-inner-dark", dark = true)
}
