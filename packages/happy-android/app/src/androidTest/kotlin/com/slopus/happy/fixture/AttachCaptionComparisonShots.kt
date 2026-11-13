package com.slopus.happy.fixture

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.attachments.GalleryAccess
import com.slopus.happy.ui.attach.AttachTags
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The attach sheet's caption bar and the chat's composer in the same states, to set side by side:
 * empty, one line and long (past its lines, scrolled), the keyboard up and down. The `dark`
 * argument draws it dark. Shots go to `device-evidence/caption-compare/` as `chat-*` and `sheet-*`.
 */
@RunWith(AndroidJUnit4::class)
class AttachCaptionComparisonShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val dark = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private val evidence = File(app.filesDir, "device-evidence/caption-compare").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val seeded = ArrayList<Uri>()
    private val long = (1..12).joinToString("\n") { "Line $it of a long caption" }

    private fun node(tag: String) = rule.onNodeWithTag(tag, useUnmergedTree = true)
    private fun waitFor(tag: String, count: Int = 1) = rule.waitUntil(60_000) { rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size >= count }

    @After fun clean() {
        seeded.forEach { runCatching { app.contentResolver.delete(it, null, null) } }
        scope.cancel()
    }

    private fun shot(name: String) {
        // The test's clock draws frames only when it is waited on: settle it, then let the
        // keyboard's inset animation run and settle again.
        repeat(3) {
            SystemClock.sleep(500)
            rule.waitForIdle()
        }
        device.takeScreenshot(File(evidence, "$name-${if (dark) "dark" else "light"}.png"))
    }

    /** Typed through the keyboard, as a person types: the field's own window takes it. */
    private fun type(words: String) {
        words.split("\n").forEachIndexed { index, line ->
            if (index > 0) device.pressEnter()
            if (line.isNotEmpty()) device.executeShellCommand("input text ${line.replace(" ", "%s")}")
        }
        SystemClock.sleep(300)
    }

    /** A finger on the field, as a person taps it: its window takes focus and the keyboard. */
    private fun tap(tag: String) {
        val node = node(tag).fetchSemanticsNode()
        val at = node.positionOnScreen
        device.click((at.x + node.size.width / 2).toInt(), (at.y + node.size.height / 2).toInt())
        SystemClock.sleep(800)
    }

    private fun openSheet() {
        node(ConversationComposerTags.MORE).performClick()
        waitFor(AttachTags.CHECK, 3)
        SystemClock.sleep(1_000)
        rule.onAllNodesWithTag(AttachTags.CHECK, useUnmergedTree = true)[1].performClick()
        rule.onAllNodesWithTag(AttachTags.CHECK, useUnmergedTree = true)[2].performClick()
        waitFor(AttachTags.CAPTION)
    }

    private fun keyboardDown() {
        device.pressBack()
        SystemClock.sleep(600)
    }

    @Test fun captionBarBesideTheComposer() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        for (permission in GalleryAccess.permissions()) runCatching { automation.grantRuntimePermission(app.packageName, permission) }
        repeat(9) { index ->
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "caption_compare_$index.jpg")
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/HappyAttachFixture")
            }
            val uri = app.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
            val bitmap = Bitmap.createBitmap(600, 800, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.HSVToColor(floatArrayOf(index * 40f, 0.55f, 0.9f))) }
            app.contentResolver.openOutputStream(uri)!!.use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            seeded += uri
        }
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        val transport = FixtureTransport()
        rule.setContent { HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light) { FixtureScreens(transport, scope) { it.start() } } }
        waitFor(ConversationComposerTags.INPUT)

        // Empty: the chat's composer, then the sheet's caption (the caption is the draft).
        shot("chat-1-empty-keyboard-down")
        tap(ConversationComposerTags.INPUT)
        shot("chat-2-empty-keyboard-up")
        keyboardDown()
        openSheet()
        shot("sheet-1-empty-keyboard-down")
        tap(AttachTags.CAPTION)
        shot("sheet-2-empty-keyboard-up")
        keyboardDown()
        device.pressBack()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(AttachTags.SHEET, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }

        // One line.
        tap(ConversationComposerTags.INPUT)
        type("Here they are")
        shot("chat-3-line-keyboard-up")
        keyboardDown()
        shot("chat-4-line-keyboard-down")
        openSheet()
        tap(AttachTags.CAPTION)
        shot("sheet-3-line-keyboard-up")
        keyboardDown()
        shot("sheet-4-line-keyboard-down")

        // Long: past the lines each shows, scrolled to the caret.
        tap(AttachTags.CAPTION)
        type("\n" + long)
        shot("sheet-5-long-keyboard-up")
        keyboardDown()
        shot("sheet-6-long-keyboard-down")
        device.pressBack()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag(AttachTags.SHEET, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        tap(ConversationComposerTags.INPUT)
        shot("chat-5-long-keyboard-up")
        keyboardDown()
        shot("chat-6-long-keyboard-down")
    }
}
