package com.slopus.happy.fixture

import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
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
    val rule = createAndroidComposeRule<ComponentActivity>()

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

    /**
     * The window set up as MainActivity sets its own: edge to edge, and
     * resized for the keyboard (its manifest's adjustResize). What this host
     * can't copy is MainActivity's configChanges: rotating recreates this
     * activity and drops the test's content, so rotation of our own screens
     * is not checked here.
     */
    private fun show(until: String = ConversationRowTags.MEDIA) {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        rule.setContent { HappyTheme { FixtureScreens(transport, scope) { it.start() } } }
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(until, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun capture(name: String) {
        SystemClock.sleep(600)
        val file = File(evidence, "$name.png")
        device.takeScreenshot(file)
        log("$name captured; in front: ${device.currentPackageName}")
    }

    private fun log(line: String) = android.util.Log.i("FixtureEvidence", line)

    private companion object {
        val SYSTEM_OVERLAYS = setOf("android", "com.android.systemui")
    }

    /** The chat is in front and showing its list: what Back should always come back to. */
    private fun assertChatInFront(step: String) {
        device.waitForIdle()
        val front = device.currentPackageName
        log("$step: in front $front")
        assertTrue("$step: expected the app in front, was $front", front == app.packageName)
        rule.onNodeWithTag(ConversationScreenTags.LIST, useUnmergedTree = true).assertIsDisplayed()
    }

    /**
     * The app that took the intent. The system's own overlays (the one-time
     * "Viewing full screen" tip a video player triggers, owned by `android`)
     * sit above it and are not it: the tip is dismissed with its own button,
     * logged, and the wait goes on for the real handler.
     */
    private fun otherAppInFront(step: String, waitMillis: Long = 10_000): String {
        val until = SystemClock.uptimeMillis() + waitMillis
        while (SystemClock.uptimeMillis() < until) {
            val front = device.currentPackageName
            if (front in SYSTEM_OVERLAYS) {
                device.findObject(By.text("Got it"))?.let {
                    log("$step: system tip over the handler ($front), dismissed with Got it")
                    capture("$step-system-tip".replace(' ', '-'))
                    it.click()
                }
            } else if (front != null && front != app.packageName) {
                log("$step: handled by $front")
                return front
            }
            SystemClock.sleep(250)
        }
        log("$step: no other app took it; in front ${device.currentPackageName}")
        return device.currentPackageName ?: ""
    }

    /** Back until [target] is in front, at most three presses; how many it took is part of the evidence. */
    private fun backTo(step: String, target: () -> Boolean): Int {
        for (presses in 1..3) {
            device.pressBack()
            SystemClock.sleep(1_000)
            device.waitForIdle()
            if (target()) {
                log("$step: $presses Back press(es) to return")
                return presses
            }
            log("$step: after $presses Back press(es) in front ${device.currentPackageName}")
        }
        return -1
    }

    private fun chatShowing() = device.currentPackageName == app.packageName &&
        rule.onAllNodesWithTag(ConversationScreenTags.LIST, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun artifactShowing() = device.currentPackageName == app.packageName &&
        rule.onAllNodesWithTag(ArtifactTags.SCREEN, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test fun picture_opens_full_screen_and_back_returns_to_the_chat() {
        show()
        capture("01-chat")
        // A presented picture's tile is labelled with its file name.
        rule.onNodeWithContentDescription("sample.png", useUnmergedTree = true).performScrollTo().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(PictureViewerTags.VIEWER, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("02-picture-viewer")
        // Rotation is not checked here: this host is recreated on rotation, MainActivity is not.
        assertTrue("picture back: never returned to the chat", backTo("picture back", ::chatShowing) > 0)
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
        // The handler's own rotation only; ours is not checked in this host.
        device.setOrientationLeft()
        capture("07-video-rotated-in-handler")
        device.setOrientationNatural()
        log("video handler was $handler")
        assertTrue("video back: never returned to the chat", backTo("video back", ::chatShowing) > 0)
        assertChatInFront("video back")
        capture("08-video-back")
    }

    @Test fun document_hands_off_to_another_app_and_back_returns_to_the_chat() {
        show()
        rule.onNodeWithText("sample.pdf", substring = true, useUnmergedTree = true).performScrollTo().performClick()
        val handler = otherAppInFront("document open")
        capture("09-document-handler")
        log("document handler was $handler")
        assertTrue("document back: never returned to the chat", backTo("document back", ::chatShowing) > 0)
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
                log("artifact $slug handler was $handler")
                assertTrue("artifact $slug: never returned from $handler", backTo("artifact $slug handler back", ::artifactShowing) > 0)
                log("artifact $slug: back from handler lands on the artifact screen")
            }
            device.pressBack()
            rule.waitForIdle()
            assertChatInFront("artifact $slug back")
        }
    }

    @Test fun secret_form_with_the_keyboard_up() = secretForm("13", "14", "15")

    /**
     * The same form on a short screen: landscape here is 411dp tall. Turned
     * before anything is shown, so the host's recreation happens while it is
     * still empty; nothing is rotated once content is up.
     */
    @Test fun secret_form_with_the_keyboard_up_on_a_short_screen() {
        device.setOrientationLeft()
        device.waitForIdle()
        log("short screen: display ${device.displayWidth}x${device.displayHeight}")
        secretForm("16-short", "17-short", "18-short")
    }

    private fun secretForm(down: String, up: String, swiped: String) {
        transport.question = FixtureTransport.SECRET_QUESTION
        // The question card is tall enough that the media rows above it are never composed.
        show(until = SecretRequestTags.FORM)
        capture("$down-secret-keyboard-down")
        logSave("keyboard down")
        val field = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true).onFirst()
        field.performScrollTo()
        logValue("scrolled to")
        field.performClick()
        logValue("tapped")
        SystemClock.sleep(1_200)
        rule.waitForIdle()
        logValue("tapped, keyboard settled")
        capture("$up-secret-tapped")
        field.performTextInput("synthetic-value")
        logValue("right after input")
        SystemClock.sleep(1_200)
        rule.waitForIdle()
        logValue("after the keyboard settled")
        capture("$up-secret-keyboard-up")
        logSave("keyboard up, first value focused")
        // Whether a finger reaches Save with the keyboard still up: swipe the card, never tap Save.
        var swipes = 0
        while (swipes < 4 && saveClipped()) {
            rule.onNodeWithTag(SecretRequestTags.FORM, useUnmergedTree = true).performTouchInput { swipeUp() }
            rule.waitForIdle()
            swipes++
        }
        log("secret keyboard up: $swipes swipe(s) on the card, save visible ${!saveClipped()}, keyboard up ${keyboardUp()}")
        logSave("keyboard up, after swiping the card")
        logValue("after swiping the card")
        capture("$swiped-secret-save-after-swipe")
        // The value typed was synthetic and nothing was saved: the form is never submitted here.
        assertTrue(transport.requests.none { it.startsWith("POST /v0/secrets") })
    }

    /** Where Save sits against the visible window, the focused field and the keyboard, in px. */
    private fun logSave(state: String) {
        val save = rule.onAllNodesWithTag(SecretRequestTags.SUBMIT, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        val focused = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        val visible = android.graphics.Rect().also { rule.activity.window.decorView.getWindowVisibleDisplayFrame(it) }
        val ime = androidx.core.view.ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
            ?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
        // boundsInWindow is clipped by the card's scroll; position and size are not.
        log(
            "secret $state: save clipped ${save?.boundsInWindow} unclipped at ${save?.positionInWindow} size ${save?.size}" +
                " first value field ${focused?.boundsInWindow} visible frame $visible ime bottom inset ${ime?.bottom}",
        )
    }

    private fun saveClipped() =
        rule.onAllNodesWithTag(SecretRequestTags.SUBMIT, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
            ?.boundsInWindow?.isEmpty ?: true

    private fun keyboardUp() = androidx.core.view.ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
        ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true

    /** How many characters the first value field holds (its masked text's length, never the text) and whether it has focus. */
    private fun logValue(state: String) {
        val node = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        val length = node?.config?.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.EditableText) { null }?.length
        val focused = node?.config?.getOrElseNullable(androidx.compose.ui.semantics.SemanticsProperties.Focused) { null }
        // The top bar's place in the window: below zero means the window was panned, not laid out.
        val bar = rule.onAllNodesWithTag(ConversationScreenTags.BAR, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        log("secret value $state: node ${node?.id} length $length focused $focused field at ${node?.positionInWindow} bar at ${bar?.positionInWindow}")
    }
}
