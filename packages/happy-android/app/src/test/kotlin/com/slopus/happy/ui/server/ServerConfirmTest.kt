package com.slopus.happy.ui.server

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.AuthApi.ServerProbe
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/**
 * server.tsx: Change Server and Reset to Default ask with `Modal.confirm`,
 * which is not cancelable: back leaves the question up, and only Cancel or
 * the action answers it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ServerConfirmTest {
    @get:Rule val rule = createComposeRule()

    /** Back, as the system sends it to the alert's window. */
    private fun pressBack() = rule.runOnUiThread { ShadowDialog.getLatestDialog().onBackPressed() }

    /** TalkBack: the title is a header, the confirm's answers are named buttons, nothing actionable unnamed. */
    @Test
    fun serverScreenAndConfirmReadForTalkBack() {
        rule.setHappyContent {
            ServerScreen(customUrl = null, probe = { ServerProbe.HappyServer }, onSave = {}, onReset = {}, onBack = {})
        }
        rule.onNode(isHeading(), useUnmergedTree = true).assertExists()
        rule.assertActionsLabelled()
        rule.node(ServerTags.INPUT).performTextReplacement("https://happy.example.com")
        rule.node(ServerTags.SAVE).performClick()
        rule.onNode(hasText("Continue") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasText("Cancel") and hasRole(Role.Button)).assertExists()
        rule.assertActionsLabelled()
    }

    @Test
    fun changeServerOutlastsBack() {
        var saved: String? = null
        rule.setHappyContent {
            ServerScreen(customUrl = null, probe = { ServerProbe.HappyServer }, onSave = { saved = it }, onReset = {}, onBack = {})
        }
        rule.node(ServerTags.INPUT).performTextReplacement("https://happy.example.com")
        rule.node(ServerTags.SAVE).performClick()
        rule.onNodeWithText("Continue with this server?").assertExists()
        pressBack()
        rule.waitForIdle()
        rule.onNodeWithText("Continue with this server?").assertExists()
        rule.onNodeWithText("Continue").performClick()
        assertEquals("https://happy.example.com", saved)
    }

    @Test
    fun resetToDefaultOutlastsBack() {
        var reset = 0
        rule.setHappyContent {
            ServerScreen(customUrl = "https://happy.example.com", probe = { ServerProbe.HappyServer }, onSave = {}, onReset = { reset++ }, onBack = {})
        }
        rule.node(ServerTags.RESET).performClick()
        rule.onNodeWithText("Reset server to default?").assertExists()
        pressBack()
        rule.waitForIdle()
        rule.onNodeWithText("Reset server to default?").assertExists()
        rule.onNodeWithText("Cancel").performClick()
        rule.onNodeWithText("Reset server to default?").assertDoesNotExist()
        assertEquals(0, reset)
    }
}
