package com.slopus.happy.fixture

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
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
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.attachments.GalleryAccess
import com.slopus.happy.attachments.PickedKind
import com.slopus.happy.attachments.PickedMedia
import com.slopus.happy.attachments.RecentFiles
import com.slopus.happy.ui.attach.AttachTags
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.conversation.ConversationRowTags
import com.slopus.happy.ui.conversation.PictureViewerTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The attachment sheet on a device, over the fixture agent: the gallery
 * read from MediaStore (pictures and a clip this test puts there and takes
 * away again), the real Conversation sending what is picked. Captures go to
 * `device-evidence/attach/`; the `dark` argument draws it dark.
 */
@RunWith(AndroidJUnit4::class)
class AttachSheetDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val dark = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private val evidence = File(app.filesDir, "device-evidence/attach").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val transport = FixtureTransport()
    private val seeded = ArrayList<Uri>()

    private fun node(tag: String) = rule.onNodeWithTag(tag, useUnmergedTree = true)
    private fun all(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true)
    private fun waitFor(tag: String, count: Int = 1, millis: Long = 15_000) = rule.waitUntil(millis) { all(tag).fetchSemanticsNodes().size >= count }
    private fun waitGone(tag: String) = rule.waitUntil(15_000) { all(tag).fetchSemanticsNodes().isEmpty() }

    @Before fun seed() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        for (permission in GalleryAccess.permissions()) runCatching { automation.grantRuntimePermission(app.packageName, permission) }
        val colors = listOf(0xFF2E86DE to 0xFF54A0FF, 0xFFEE5253 to 0xFFFF9F43, 0xFF10AC84 to 0xFF1DD1A1, 0xFF5F27CD to 0xFF9B59B6, 0xFFF368E0 to 0xFFFECA57, 0xFF222F3E to 0xFF576574, 0xFF0ABDE3 to 0xFF48DBFB, 0xFFFF6B6B to 0xFFFFD166)
        colors.forEachIndexed { index, (from, to) -> seeded += insertPicture("attach_fixture_$index.jpg", from.toInt(), to.toInt(), index + 1) }
        seeded += insertVideo("attach_fixture_clip.mp4")
        val doc = File(app.cacheDir, "Fixture notes.pdf").apply { writeBytes(transport.pdf) }
        RecentFiles(app).remember(listOf(PickedMedia(Uri.fromFile(doc).toString(), PickedKind.File, doc.name, "application/pdf", doc.length())))
    }

    @After fun clean() {
        seeded.forEach { runCatching { app.contentResolver.delete(it, null, null) } }
        RecentFiles(app).clear()
        scope.cancel()
    }

    private fun insertPicture(name: String, from: Int, to: Int, number: Int): Uri {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/HappyAttachFixture")
        }
        val uri = app.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        val bitmap = Bitmap.createBitmap(900, 1200, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, 900f, 1200f, from, to, Shader.TileMode.CLAMP) })
        canvas.drawText("$number", 450f, 700f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE; textSize = 360f; textAlign = Paint.Align.CENTER })
        app.contentResolver.openOutputStream(uri)!!.use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        return uri
    }

    private fun insertVideo(name: String): Uri {
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/HappyAttachFixture")
        }
        val uri = app.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)!!
        app.contentResolver.openOutputStream(uri)!!.use { it.write(transport.mp4) }
        return uri
    }

    private fun show() {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        rule.setContent {
            HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light) {
                FixtureScreens(transport, scope) { it.start() }
            }
        }
        waitFor(ConversationRowTags.MEDIA)
    }

    private fun open() {
        node(ConversationComposerTags.MORE).performClick()
        waitFor(AttachTags.SHEET)
        try {
            // MediaStore can be slow to answer while it indexes what @Before just added.
            waitFor(AttachTags.CELL, 9, millis = 60_000)
        } catch (e: Throwable) {
            capture("00-open-failed")
            throw e
        }
    }

    private fun capture(name: String) {
        SystemClock.sleep(900)
        device.takeScreenshot(File(evidence, "$name-${if (dark) "dark" else "light"}.png"))
    }

    @Test fun picks_photos_and_a_clip_and_sends_them_with_the_caption() {
        show()
        open()
        capture("01-open")
        node(AttachTags.tab(AttachTabKind.Files)).performClick()
        waitFor(AttachTags.RECENT)
        capture("02-files")
        node(AttachTags.tab(AttachTabKind.Gallery)).performClick()
        waitFor(AttachTags.CELL, 9)
        // The newest first: the clip, then the pictures, last made first.
        all(AttachTags.CELL)[1].performClick()
        waitFor(PictureViewerTags.VIEWER)
        capture("03-preview")
        device.pressBack()
        waitGone(PictureViewerTags.VIEWER)
        val checks = all(AttachTags.CHECK)
        checks[1].performClick()
        checks[0].performClick()
        checks[2].performClick()
        waitFor(AttachTags.CAPTION_BAR)
        capture("04-picked")
        node(AttachTags.CAPTION).performTextInput("Here they are")
        assertEquals("Here they are", node(AttachTags.CAPTION).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text)
        // The caption bar rides above the keyboard.
        SystemClock.sleep(1_500)
        capture("05-caption")
        node(AttachTags.SEND).performClick()
        rule.waitUntil(30_000) { transport.bodies.any { it.first.endsWith("/send") } }
        waitGone(AttachTags.SHEET)
        capture("06-sent")

        val puts = transport.bodies.filter { it.first.endsWith("/file") }
        val send = transport.bodies.single { it.first.endsWith("/send") }.second as JsonObject
        val id = (send["id"] as JsonPrimitive).content
        // The clip, picked second, went into the workspace; the two pictures inline.
        assertEquals(listOf("PUT /v0/workspaces/fx-workspace/file"), puts.map { it.first })
        assertEquals(".happy-uploads/$id/1-attach_fixture_clip.mp4", ((puts.single().second as JsonObject)["path"] as JsonPrimitive).content)
        assertEquals(
            "Here they are\n\nAttached file:\n- ./.happy-uploads/$id/1-attach_fixture_clip.mp4",
            (send["text"] as JsonPrimitive).content,
        )
        assertEquals(2, (send["content"] as JsonArray).size)
        assertTrue("file before send", transport.requests.indexOfFirst { it.endsWith("/file") } < transport.requests.indexOfFirst { it.endsWith("/send") })
    }

    @Test fun a_pull_down_and_back_close_it_and_leave_the_draft() {
        show()
        node(ConversationComposerTags.INPUT).performTextInput("draft stays")
        open()
        node(AttachTags.GALLERY).performTouchInput { swipeDown(startY = centerY - 200f, endY = centerY + 600f, durationMillis = 300) }
        waitGone(AttachTags.SHEET)
        open()
        SystemClock.sleep(600)
        device.pressBack()
        waitGone(AttachTags.SHEET)
        node(ConversationComposerTags.INPUT).fetchSemanticsNode().config.let {
            assertEquals("draft stays", it[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text)
        }
    }
}
