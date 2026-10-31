package com.slopus.happy.ui

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.conversation.ChiefOfStaffScreen
import com.slopus.happy.ui.conversation.AgentPageScreen
import com.slopus.happy.ui.conversation.AgentPageActions
import com.slopus.happy.ui.conversation.AgentPageFixtures
import com.slopus.happy.ui.troubleshoot.TroubleshootComputer
import com.slopus.happy.ui.troubleshoot.TroubleshootScreen
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Screens under a glass top bar, for review, written only when
 * HAPPY_SHOTS_DIR is set: the legacy chat with its transcript running under
 * the bar, an agent's page and the troubleshooting page scrolled
 * under theirs, and the Chief of Staff lookup; light and dark.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassScreenShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private fun shot(name: String, dark: Boolean, scroll: Boolean = false, content: @Composable () -> Unit) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark) { content() }
        rule.waitForIdle()
        if (scroll) {
            rule.onRoot().performTouchInput { swipeUp(startY = centerY + 300f, endY = centerY - 200f) }
            rule.waitForIdle()
        }
        rule.mainClock.advanceTimeBy(1_000)
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name-${if (dark) "dark" else "light"}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private val session = ChatSessionInfo.from(
        SessionRecord(
            "s", 0, 0, 1, true, 0,
            """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux","summary":{"text":"Fix the login redirect","updatedAt":1}}""",
            1, null, 1, "", null,
        ),
    )

    private val transcript = (0 until 12).flatMap { i ->
        listOf(
            ChatReduction.buildRow(
                ChatMessage.AgentText(
                    "a$i", 2L * i + 1,
                    "Step ${i + 1}: the redirect reads the **session cookie** before the auth callback has written it, so the guard sends the reader back to `/login`. " +
                        "Moving the check after the callback fixes the loop.",
                ),
                true,
            )!!,
            ChatReduction.buildRow(ChatMessage.UserText("u$i", "l$i", 2L * i, "What happens at step ${i + 1}?"), false)!!,
        )
    }.asReversed()

    private fun chat(dark: Boolean) = shot("glass-chat", dark) {
        ChatScreen(
            state = ChatState(ChatSnapshot(transcript, loaded = true), session, sessionLoaded = true, online = true),
            draft = "",
            bubbleColor = "gray",
            actions = ChatScreenActions(),
        )
    }

    private fun details(dark: Boolean) = shot("glass-details", dark, scroll = true) { AgentPageScreen(AgentPageFixtures.page, AgentPageActions(), now = AgentPageFixtures.NOW) }

    private fun chief(dark: Boolean) = shot("glass-chief", dark) { ChiefOfStaffScreen("There's no Chief of Staff on this computer.", onRetry = {}, onBack = {}) }

    private fun troubleshoot(dark: Boolean) = shot("glass-troubleshoot", dark, scroll = true) {
        TroubleshootScreen(
            computers = listOf(TroubleshootComputer("mac", "Mac", online = false, activeAt = 1)),
            aiPrompt = "In ~/.happy, diagnose why the daemon is offline",
            onOpenMachine = {},
            onOpenUrl = {},
            onBack = {},
        )
    }

    @Test fun chatLight() = chat(false)
    @Test fun chatDark() = chat(true)
    @Test fun detailsLight() = details(false)
    @Test fun detailsDark() = details(true)
    @Test fun chiefLight() = chief(false)
    @Test fun chiefDark() = chief(true)
    @Test fun troubleshootLight() = troubleshoot(false)
    @Test fun troubleshootDark() = troubleshoot(true)
}
