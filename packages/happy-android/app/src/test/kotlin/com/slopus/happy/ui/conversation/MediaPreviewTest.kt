package com.slopus.happy.ui.conversation

import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.files.FileLoad
import com.slopus.happy.ui.files.FileTags
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** desktop 24f532b3, 30b9e165: a presented text, source or Markdown file opens in the app's file viewer. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class MediaPreviewTest {
    @get:Rule
    val rule = createComposeRule()

    private fun item(name: String, size: Double? = null) = MediaItem("file", name, "application/octet-stream", size = size)

    @Test fun `the name says what reads as text`() {
        assertTrue(PresentedFile.previews(item("notes/plan.md")))
        assertTrue(PresentedFile.previews(item("main.kt")))
        assertTrue(PresentedFile.previews(item("server.log")))
        assertTrue(PresentedFile.previews(item("Makefile")))
        assertFalse(PresentedFile.previews(item("report.zip")))
        assertFalse(PresentedFile.previews(item("photo.png")))
        assertFalse("over 2 MB is not read", PresentedFile.previews(item("huge.md", size = 3.0 * 1024 * 1024)))
    }

    @Test fun `a Markdown file opens rendered in the app, and back closes it`() {
        lateinit var opener: MediaOpener
        rule.setHappyContent {
            val context = LocalContext.current
            val scope = rememberCoroutineScope()
            opener = androidx.compose.runtime.remember { MediaOpener(context, scope, MediaOpenerText("no app", "failed")) }
            MediaPreview(opener)
        }
        rule.runOnIdle { opener.open("t/0", item("plan.md"), inApp = true) { "# Plan\n\nShip it.".toByteArray() } }
        rule.waitUntil(5_000) { opener.preview != null }
        assertTrue(opener.preview!!.load is FileLoad.Loaded)
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Plan", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1, rule.onAllNodesWithTag(FileTags.RENDERED, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals("every presented file saves too", 1, rule.onAllNodesWithTag(FileTags.SAVE, useUnmergedTree = true).fetchSemanticsNodes().size)
        rule.onAllNodes(androidx.compose.ui.test.hasContentDescription("Back"))[0].performClick()
        rule.waitForIdle()
        assertNull(opener.preview)
    }

    @Test fun `bytes that are not text go to the phone instead`() {
        lateinit var opener: MediaOpener
        rule.setHappyContent {
            val context = LocalContext.current
            val scope = rememberCoroutineScope()
            opener = androidx.compose.runtime.remember { MediaOpener(context, scope, MediaOpenerText("no app", "failed")) }
            MediaPreview(opener)
        }
        rule.runOnIdle { opener.open("t/1", item("data.txt"), inApp = true) { byteArrayOf(0, 1, 2, 3) } }
        rule.waitUntil(5_000) { opener.state("t/1") !is MediaOpening.Reading }
        assertNull(opener.preview)
    }
}
