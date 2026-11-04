package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Data and Storage as kept chat media needs it (iOS ba7b68346): the size
 * kept, Clear Media after a confirm, and Automatic Media Download's
 * switches and limits.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DataStorageScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun itShowsTheSizeKeptClearsAfterAConfirmAndChangesTheRules() {
        var rules by mutableStateOf(MediaAutoDownload())
        var cleared = 0
        var choosing: MediaAutoDownload.Kind? = null
        rule.setHappyContent {
            DataStorageScreen(usage = 12L * 1024 * 1024, rules = rules, onRules = { rules = it }, onClear = { cleared++ }, onBack = {}, onChooseLimit = { choosing = it })
        }
        rule.onNodeWithText("12 MB").assertExists()
        File("build/chat-screens").mkdirs()
        File("build/chat-screens/data-storage.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }

        rule.onNodeWithTag(DataStorageTags.CLEAR, useUnmergedTree = true).performClick()
        assertEquals("asks first", 0, cleared)
        rule.onNodeWithText("Clear").performClick()
        assertEquals(1, cleared)

        rule.onNodeWithTag(DataStorageTags.switch(MediaAutoDownload.Kind.Videos), useUnmergedTree = true).performClick()
        rule.waitForIdle()
        assertEquals(true, rules.videos.enabled)
        rule.onNodeWithTag(DataStorageTags.limit(MediaAutoDownload.Kind.Photos), useUnmergedTree = true).performClick()
        assertEquals(MediaAutoDownload.Kind.Photos, choosing)
    }

    @Test
    fun limitChoicesShareOneCardCheckTheCurrentLimitAndReturnTheSelection() {
        var selected: Long? = null
        val current = 10 * MediaAutoDownload.MEGABYTE
        rule.setHappyContent { MediaLimitScreen(current, { selected = it }, {}) }
        rule.onAllNodesWithTag(ItemGroupTags.CARD, useUnmergedTree = true).assertCountEquals(1)
        rule.node(DataStorageTags.choice(current)).assertIsSelected()
        val rows = MediaAutoDownload.limits.map { rule.node(DataStorageTags.choice(it)).bounds }
        for (row in rows) {
            assertDp("row height", 56.dp, row.height)
            assertDp("same left edge", rows.first().left, row.left)
            assertDp("same right edge", rows.first().right, row.right)
        }
        for ((previous, next) in rows.zipWithNext()) assertDp("no gap between choices", previous.bottom, next.top)
        rule.onAllNodesWithTag(ItemTags.CHEVRON, useUnmergedTree = true).assertCountEquals(0)
        rule.node(DataStorageTags.choice(25 * MediaAutoDownload.MEGABYTE)).performClick()
        assertEquals(25 * MediaAutoDownload.MEGABYTE, selected)
    }
}
