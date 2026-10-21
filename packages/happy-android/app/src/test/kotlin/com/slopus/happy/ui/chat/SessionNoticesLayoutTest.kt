package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.ResumeCommandBlock
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
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

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionNoticesLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val command = ResumeCommandBlock(listOf("cd /p", "happy claude --resume abc"), "cd /p && happy claude --resume abc")

    // Centred, 8 below the top, as tall as its 12/16 label plus 7 above and below.
    @Test
    fun thePillIsCentred() {
        var dismissed = 0
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) { CliWarningPill(onDismiss = { dismissed++ }) }
        }
        val pill = rule.node(SessionNoticeTags.CLI_WARNING).bounds
        assertDp("pill top", 8, pill.top)
        assertDp("pill centre", (PHONE_WIDTH / 2f).dp, (pill.left + pill.right) / 2)
        assertTrue("pill height ${pill.height}", pill.height >= 28.dp && pill.height <= 32.dp)
        rule.onNodeWithText("CLI Update Required").performClick()
        assertEquals(1, dismissed)
    }

    // The Resume button spans the column less 8 each side, 44 high, 10 under the text.
    @Test
    fun resumeButtonGeometry() {
        var resumed = 0
        rule.setHappyContent { InactiveArchivedHint(InactiveHint(canResume = true, resuming = false, resumeCommand = command), onResume = { resumed++ }) }
        val text = rule.node(SessionNoticeTags.INACTIVE_TEXT).bounds
        val button = rule.node(SessionNoticeTags.RESUME).bounds
        assertDp("text top", 12, text.top)
        assertDp("text left", 8, text.left)
        assertDp("button left", 8, button.left)
        assertDp("button width", PHONE_WIDTH - 16, button.width)
        assertDp("button height", 44, button.height)
        assertDp("gap", 10, button.top - text.bottom)
        assertDp("hint bottom", button.bottom + 10.dp, rule.node(SessionNoticeTags.INACTIVE).bounds.bottom)
        rule.onNodeWithText("To resume it from the terminal:").assertDoesNotExist()
        rule.node(SessionNoticeTags.RESUME_COMMAND).assertDoesNotExist()
        rule.node(SessionNoticeTags.RESUME).performClick()
        assertEquals(1, resumed)
    }

    @Test
    fun resumingDisablesTheButton() {
        var resumed = 0
        rule.setHappyContent { InactiveArchivedHint(InactiveHint(canResume = true, resuming = true, resumeCommand = null), onResume = { resumed++ }) }
        rule.onNodeWithText("Resume Session").assertDoesNotExist()
        // The spinner stands in for the label, but TalkBack still names the button.
        rule.node(SessionNoticeTags.RESUME).assert(hasContentDescription("Resume Session"))
        rule.node(SessionNoticeTags.RESUME).performClick()
        assertEquals(0, resumed)
    }

    // Without Resume, the command block fills the width, each line its own 18-high row.
    @Test
    fun theCommandBlockShowsEachLine() {
        rule.setHappyContent { InactiveArchivedHint(InactiveHint(canResume = false, resuming = false, resumeCommand = command), onResume = {}) }
        rule.onNodeWithText("To resume it from the terminal:").assertExists()
        rule.onNodeWithText("cd /p").assertExists()
        rule.onNodeWithText("happy claude --resume abc").assertExists()
        rule.node(SessionNoticeTags.RESUME).assertDoesNotExist()
        val block = rule.node(SessionNoticeTags.RESUME_COMMAND).bounds
        assertDp("block left", 0, block.left)
        assertDp("block width", PHONE_WIDTH, block.width)
        assertDp("block height", 12 + 18 + 18 + 12, block.height)
    }
}
