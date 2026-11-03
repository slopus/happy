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
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.media.MediaAutoDownload
import com.slopus.happy.ui.PHONE
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
        rule.setHappyContent {
            DataStorageScreen(usage = 12L * 1024 * 1024, rules = rules, onRules = { rules = it }, onClear = { cleared++ }, onBack = {})
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
        rule.onNodeWithText("25 MB").performClick()
        assertEquals(25 * MediaAutoDownload.MEGABYTE, rules.photos.limit)
    }
}
