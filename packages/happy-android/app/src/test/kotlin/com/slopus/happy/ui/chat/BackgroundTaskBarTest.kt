package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.BackgroundTask
import com.slopus.happy.chat.BackgroundTaskKind
import com.slopus.happy.chat.BackgroundTaskStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The background-task pill over the composer and the sheet it opens. Spec
 * (BackgroundTaskBar.kt's KDoc): the pill is 32 high (12/16 semibold label,
 * 8 above and below) with a 16 glyph and a 14 chevron; the sheet lists
 * running tasks before the most recently finished.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BackgroundTaskBarTest {
    @get:Rule
    val rule = createComposeRule()

    private val running = BackgroundTask(
        id = "call:1", kind = BackgroundTaskKind.Command, title = "Build the app", command = "npm run build",
        startedAt = 1_000, status = BackgroundTaskStatus.Running,
    )
    private val runningSecond = BackgroundTask(
        id = "call:2", kind = BackgroundTaskKind.Subagent, title = "Research the API", startedAt = 2_000,
        status = BackgroundTaskStatus.Running,
    )
    private val finished = BackgroundTask(
        id = "task:3", kind = BackgroundTaskKind.Command, title = "Run the tests", command = "npm test",
        startedAt = 500, finishedAt = 3_000, status = BackgroundTaskStatus.Failed,
        summary = "Background command \"Run the tests\" failed (exit code 1)",
    )

    @Test
    fun thePillIsCompactAndCountsWhatRuns() {
        var opened = 0
        rule.setHappyContent {
            Box(Modifier.fillMaxSize()) {
                BackgroundTaskChip(listOf(running, runningSecond, finished), onClick = { opened++ }, Modifier.padding(start = 8.dp, top = 8.dp))
            }
        }
        val chip = rule.node(BackgroundTaskTags.CHIP).bounds
        assertDp("chip left", 8, chip.left)
        assertDp("chip top", 8, chip.top)
        assertDp("chip height", 32, chip.height)
        val chipWidth = chip.right - chip.left
        assertTrue("chip width $chipWidth", chipWidth < 220.dp)
        rule.onNodeWithText("2 running").assertIsDisplayed()
        rule.node(BackgroundTaskTags.CHIP).performClick()
        assertEquals(1, opened)
    }

    @Test
    fun onlyFinishedTasksReadAsFinished() {
        rule.setHappyContent { BackgroundTaskChip(listOf(finished), onClick = {}) }
        rule.onNodeWithText("1 finished").assertIsDisplayed()
    }

    @Test
    fun theSheetListsRunningBeforeFinished() {
        rule.setHappyContent {
            var open by remember { mutableStateOf(false) }
            Box(Modifier.fillMaxSize()) {
                BackgroundTaskChip(listOf(finished, runningSecond, running), onClick = { open = true })
                if (open) BackgroundTaskSheet(listOf(finished, runningSecond, running), onDismiss = { open = false })
            }
        }
        rule.node(BackgroundTaskTags.SHEET).assertDoesNotExist()
        rule.node(BackgroundTaskTags.CHIP).performClick()
        rule.waitForIdle()
        rule.node(BackgroundTaskTags.SHEET).assertIsDisplayed()
        rule.onNodeWithText("Background tasks").assertIsDisplayed()
        val first = rule.node(BackgroundTaskTags.row(running.id)).bounds
        val second = rule.node(BackgroundTaskTags.row(runningSecond.id)).bounds
        val last = rule.node(BackgroundTaskTags.row(finished.id)).bounds
        assertTrue("running first", first.top < second.top && second.top < last.top)
        rule.node(BackgroundTaskTags.meta(running.id)).assert(hasText("Running", substring = true))
        rule.node(BackgroundTaskTags.meta(finished.id)).assert(hasText("Failed", substring = true))
        rule.node(BackgroundTaskTags.detail(running.id)).assert(hasText("npm run build"))
        rule.node(BackgroundTaskTags.detail(finished.id)).assert(hasText("failed", substring = true))
    }
}
