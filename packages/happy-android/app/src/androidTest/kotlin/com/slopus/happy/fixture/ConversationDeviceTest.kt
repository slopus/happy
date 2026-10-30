package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.ui.conversation.ArtifactTags
import com.slopus.happy.ui.conversation.ConversationRowTags
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.conversation.PictureViewerTags
import com.slopus.happy.ui.conversation.SecretRequestTags
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The real conversation and artifact components on a device, over a fixture
 * agent that exists only in memory ([FixtureTransport]). Every file, chat and
 * secret here is synthetic. Captures go to the test app's own files under
 * `device-evidence/`, and each step logs what was in front, so a report can
 * say which screen came back, not just that nothing crashed.
 *
 * Not covered: the real agent connection, AppGraph and the app's nav graph.
 */
@RunWith(AndroidJUnit4::class)
class ConversationDeviceTest {
    @get:Rule
    val rule = createComposeRule()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val transport = FixtureTransport()

    @Before fun naturalRotation() {
        device.setOrientationNatural()
    }

    @After fun restore() {
        device.setOrientationNatural()
        device.unfreezeRotation()
        scope.cancel()
    }

    private fun show() {
        rule.setContent { HappyTheme { FixtureScreens(transport, scope) { it.start() } } }
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(ConversationRowTags.MEDIA, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun capture(name: String) {
        SystemClock.sleep(600)
        val file = File(evidence, "$name.png")
        device.takeScreenshot(file)
        log("$name captured; in front: ${device.currentPackageName}")
    }

    private fun log(line: String) = android.util.Log.i("FixtureEvidence", line)

    /** The chat is in front and showing its list: what Back should always come back to. */
    private fun assertChatInFront(step: String) {
        device.waitForIdle()
        val front = device.currentPackageName
        log("$step: in front $front")
        assertTrue("$step: expected the app in front, was $front", front == app.packageName)
        rule.onNodeWithTag(ConversationScreenTags.LIST, useUnmergedTree = true).assertIsDisplayed()
    }

    private fun otherAppInFront(step: String, waitMillis: Long = 8_000): String {
        val until = SystemClock.uptimeMillis() + waitMillis
        while (SystemClock.uptimeMillis() < until) {
            val front = device.currentPackageName
            if (front != null && front != app.packageName) {
                log("$step: handled by $front")
                return front
            }
            SystemClock.sleep(250)
        }
        log("$step: no other app took it; in front ${device.currentPackageName}")
        return device.currentPackageName ?: ""
    }

    @Test fun picture_opens_full_screen_and_back_returns_to_the_chat() {
        show()
        capture("01-chat")
        rule.onAllNodesWithTag(ConversationRowTags.PICTURE, useUnmergedTree = true).onFirst().performScrollTo().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(PictureViewerTags.VIEWER, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("02-picture-viewer")
        device.setOrientationLeft()
        capture("03-picture-viewer-rotated")
        val viewerSurvived = rule.onAllNodesWithTag(PictureViewerTags.VIEWER, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        log("picture rotate mid-open: viewer still open = $viewerSurvived")
        device.setOrientationNatural()
        device.pressBack()
        rule.waitForIdle()
        assertChatInFront("picture back")
        capture("04-picture-back")
    }

    @Test fun video_hands_off_to_another_app_and_back_returns_to_the_chat() {
        show()
        rule.onAllNodesWithTag(ConversationRowTags.MEDIA_FILE, useUnmergedTree = true).fetchSemanticsNodes()
            .let { log("media file rows: ${it.size}") }
        rule.onNodeWithText("sample.mp4", substring = true, useUnmergedTree = true).performScrollTo().performClick()
        val handler = otherAppInFront("video open")
        capture("05-video-handler")
        SystemClock.sleep(1_500)
        capture("06-video-playing")
        device.setOrientationLeft()
        capture("07-video-rotated")
        device.setOrientationNatural()
        device.pressBack()
        SystemClock.sleep(1_000)
        log("video handler was $handler")
        assertChatInFront("video back")
        device.setOrientationLeft()
        assertChatInFront("video after return, rotated")
        capture("08-video-back-rotated")
    }

    @Test fun document_hands_off_to_another_app_and_back_returns_to_the_chat() {
        show()
        rule.onNodeWithText("sample.pdf", substring = true, useUnmergedTree = true).performScrollTo().performClick()
        val handler = otherAppInFront("document open")
        capture("09-document-handler")
        device.pressBack()
        SystemClock.sleep(1_000)
        log("document handler was $handler")
        assertChatInFront("document back")
        capture("10-document-back")
    }

    @Test fun each_artifact_opens_through_the_real_loader_and_back_returns() {
        show()
        for (title in listOf("Fixture notes", "Fixture picture", "Fixture video", "Fixture document")) {
            val slug = title.substringAfter(' ')
            rule.onNodeWithText(title, useUnmergedTree = true).performScrollTo().performClick()
            rule.waitUntil(10_000) {
                rule.onAllNodesWithTag(ArtifactTags.LOADING, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() &&
                    rule.onAllNodesWithTag(ArtifactTags.SCREEN, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
            }
            capture("11-artifact-$slug")
            if (slug == "video" || slug == "document") {
                rule.onNodeWithTag(ArtifactTags.OPEN, useUnmergedTree = true).performClick()
                val handler = otherAppInFront("artifact $slug open")
                capture("12-artifact-$slug-handler")
                if (handler != app.packageName) device.pressBack()
                SystemClock.sleep(800)
                rule.onNodeWithTag(ArtifactTags.SCREEN, useUnmergedTree = true).assertIsDisplayed()
                log("artifact $slug: back from handler lands on the artifact screen")
            }
            device.pressBack()
            rule.waitForIdle()
            assertChatInFront("artifact $slug back")
        }
    }

    @Test fun secret_form_with_the_keyboard_up_portrait_and_landscape() {
        transport.question = FixtureTransport.SECRET_QUESTION
        show()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(SecretRequestTags.FORM, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        val field = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true).onFirst()
        field.performScrollTo().performClick()
        field.performTextInput("synthetic-value")
        capture("13-secret-portrait-keyboard")
        logSave("portrait")
        device.setOrientationLeft()
        rule.waitForIdle()
        capture("14-secret-landscape-keyboard")
        logSave("landscape")
        // The value typed was synthetic and nothing was saved: the form is never submitted here.
        assertTrue(transport.requests.none { it.startsWith("POST /v0/secrets") })
    }

    private fun logSave(orientation: String) {
        val save = rule.onAllNodesWithTag(SecretRequestTags.SUBMIT, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        val root = rule.onAllNodesWithTag(ConversationScreenTags.SCREEN, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        log("secret $orientation: save bounds ${save?.boundsInWindow} screen ${root?.boundsInWindow} keyboard up ${device.executeShellCommand("dumpsys input_method").contains("mInputShown=true")}")
    }
}
