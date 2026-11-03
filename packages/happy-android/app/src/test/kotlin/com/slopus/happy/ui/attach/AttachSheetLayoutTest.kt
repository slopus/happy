package com.slopus.happy.ui.attach

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.attachments.GalleryAccess
import com.slopus.happy.attachments.GalleryItem
import com.slopus.happy.attachments.RecentFile
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
import java.io.File

/** A phone's gallery for the sheet: a video every fourth item. */
internal fun fakeGallery(count: Int = 30) = (0 until count).map { i ->
    val video = i % 4 == 1
    GalleryItem(
        id = i.toLong(),
        uri = "content://media/external/${if (video) "video" else "images"}/media/$i",
        isVideo = video,
        mimeType = if (video) "video/mp4" else "image/jpeg",
        name = "IMG_$i.jpg",
        size = 1000,
        width = 4000,
        height = 3000,
        durationMs = if (video) 7_000L + i * 1000 else 0,
    )
}

internal val fakeRecent = listOf(
    RecentFile("file:///sdcard/Report.pdf", "Report.pdf", "application/pdf", 482_000, 1_700_000_000_000),
    RecentFile("file:///sdcard/budget.csv", "budget.csv", "text/csv", 12_000, 1_699_000_000_000),
    RecentFile("file:///sdcard/notes.txt", "notes.txt", "text/plain", 900, 1_698_000_000_000),
)

/** The sheet as it rests once open, picks made through its own checks. */
@Composable
internal fun SheetUnderTest(
    content: GalleryContent = GalleryContent(GalleryAccess.Full, fakeGallery(), loaded = true),
    selection: AttachSelection = remember { AttachSelection(20) },
    startTab: AttachTabKind = AttachTabKind.Gallery,
    onClose: () -> Unit = {},
    motion: AttachSheetMotion = remember { AttachSheetMotion(settled = true) },
) {
    var tab by remember { mutableStateOf(startTab) }
    var caption by remember { mutableStateOf("") }
    AttachSheetLayout(
        tabs = listOf(AttachTabKind.Gallery, AttachTabKind.Files),
        tab = tab,
        onTab = { tab = it },
        gallery = content,
        sources = FileSources(),
        recent = fakeRecent,
        selection = selection,
        caption = caption,
        onCaptionChange = { caption = it },
        motion = motion,
        onClose = onClose,
        onSend = {},
        onToggleGallery = { selection.toggle(it.picked()) },
        onOpenGallery = {},
        onToggleFile = { selection.toggle(it.picked()) },
        onAllow = {},
        onManage = {},
        onBrowse = {},
        onFilesGallery = {},
        onPaste = {},
    )
}

/**
 * Telegram's sheet on a phone (411 × 891): the first row resting at 2/5,
 * three square columns 2 apart and 2 in, the check in each cell's 42
 * corner, the 70 tab bar at the foot; picking numbers the checks in order,
 * brings in the header and the caption bar with its count, and a pull at
 * the list's top of 0.8 cm closes it. With HAPPY_SHOTS_DIR set, its states
 * are written there as `attach-<state>-<theme>.png`.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachSheetLayoutTest {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)

    private fun shot(name: String, dark: Boolean) {
        val dir = dir ?: return
        dir.mkdirs()
        rule.mainClock.advanceTimeBy(1_000)
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "attach-$name-${if (dark) "dark" else "light"}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun cells() = rule.onAllNodesWithTag(AttachTags.CELL, useUnmergedTree = true)
    private fun checks() = rule.onAllNodesWithTag(AttachTags.CHECK, useUnmergedTree = true)

    @Test fun `the grid rests at two fifths, three columns 2 apart`() {
        rule.setHappyContent { SheetUnderTest() }
        rule.waitForIdle()
        assertDp("sheet", 411, rule.node(AttachTags.SHEET).bounds.width)
        val first = cells()[0].bounds
        val second = cells()[1].bounds
        val fourth = cells()[3].bounds
        val side = (411f - 2 * 2 - 2 * 2) / 3
        assertDp("first row at 2/5 + 4", 891 * 0.4f + 4, first.top)
        assertDp("padding", 2, first.left)
        assertDp("cell", side.dp, first.width)
        assertDp("square", side.dp, first.height)
        assertDp("gap", 2, second.left - first.right)
        assertDp("row gap", 2, fourth.top - first.bottom)
        // The check's 42 corner, top right of its cell.
        val check = checks()[0].bounds
        assertDp("check touch", 42, check.width)
        assertDp("check right", first.right, check.right)
        assertDp("check top", first.top, check.top)
        // The grabber 10 under the sheet's top, 24 over the first row.
        val grabber = rule.node(AttachTags.GRABBER).bounds
        assertDp("grabber", first.top - 24.dp + 10.dp, grabber.top)
        assertDp("grabber", 36, grabber.width)
        // The tab bar's 70 at the foot, its glass narrowed to two tabs.
        val bar = rule.node(AttachTags.TAB_BAR).bounds
        assertDp("tab bar", 70, bar.height)
        assertDp("tab bar foot", 891, bar.bottom)
        val gallery = rule.node(AttachTags.tab(AttachTabKind.Gallery)).bounds
        assertDp("tab", 48, gallery.height)
        assertDp("tab", (196f - 22) / 2, gallery.width)
        assertTrue("videos carry their length", rule.onAllNodesWithTag(AttachTags.VIDEO_BADGE, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        rule.onNodeWithText("0:08").assertIsDisplayed()
    }

    @Test fun `picking numbers the checks and brings in the caption bar`() {
        lateinit var selection: AttachSelection
        rule.setHappyContent {
            selection = remember { AttachSelection(20) }
            SheetUnderTest(selection = selection)
        }
        rule.waitForIdle()
        val restingGrabber = rule.node(AttachTags.GRABBER).bounds.top
        checks()[2].performClick()
        checks()[0].performClick()
        rule.waitForIdle()
        assertEquals(2, selection.count)
        assertEquals(1, selection.number(fakeGallery()[2].uri))
        assertEquals(2, selection.number(fakeGallery()[0].uri))
        rule.mainClock.advanceTimeBy(1_000)
        rule.node(AttachTags.CAPTION_BAR).assertIsDisplayed()
        rule.node(AttachTags.COUNTER).assertIsDisplayed()
        rule.node(AttachTags.TAB_BAR).assertDoesNotExist()
        rule.onNodeWithText("2 selected").assertIsDisplayed()
        // The sheet grew 26 at its top for the header; the grabber went with it.
        assertDp("header", restingGrabber - 26.dp, rule.node(AttachTags.GRABBER).bounds.top)
        // The send pill, its count on its top left corner.
        val send = rule.node(AttachTags.SEND).bounds
        assertDp("send", 52, send.width)
        assertDp("send", 38, send.height)
        val counter = rule.node(AttachTags.COUNTER).bounds
        assertDp("counter centre 50 left of the pill's right", send.right - 50.dp, (counter.left + counter.right) / 2)
        // Unpicking the first renumbers the second.
        checks()[2].performClick()
        rule.waitForIdle()
        assertEquals(1, selection.number(fakeGallery()[0].uri))
    }

    @Test fun `a pull of eight millimetres at the top closes it, a short one springs back`() {
        var closed = 0
        rule.setHappyContent { SheetUnderTest(onClose = { closed++ }) }
        rule.waitForIdle()
        rule.node(AttachTags.GALLERY).performTouchInput { swipeDown(startY = centerY, endY = centerY + 40f, durationMillis = 400) }
        rule.mainClock.advanceTimeBy(1_000)
        assertEquals(0, closed)
        rule.node(AttachTags.GALLERY).performTouchInput { swipeDown(startY = centerY - 300f, endY = centerY + 400f, durationMillis = 400) }
        rule.mainClock.advanceTimeBy(1_000)
        assertEquals(1, closed)
    }

    @Test fun `no access asks, partial access offers to choose more`() {
        var content by mutableStateOf(GalleryContent(GalleryAccess.None))
        rule.setHappyContent { SheetUnderTest(content = content) }
        rule.waitForIdle()
        rule.node(AttachTags.ASK).assertIsDisplayed()
        rule.node(AttachTags.ALLOW).assertIsDisplayed()
        content = GalleryContent(GalleryAccess.Partial, fakeGallery(4), loaded = true)
        rule.waitForIdle()
        rule.node(AttachTags.MANAGE).assertIsDisplayed()
        assertEquals(4, cells().fetchSemanticsNodes().size)
        content = GalleryContent(GalleryAccess.Full, emptyList(), loaded = true)
        rule.waitForIdle()
        rule.node(AttachTags.EMPTY).assertIsDisplayed()
    }

    @Test fun `the File tab lists its sources, then recent files in 64 rows`() {
        rule.setHappyContent { SheetUnderTest() }
        rule.waitForIdle()
        rule.node(AttachTags.tab(AttachTabKind.Files)).performClick()
        rule.mainClock.advanceTimeBy(1_000)
        rule.node(AttachTags.GALLERY).assertDoesNotExist()
        val browse = rule.node(AttachTags.BROWSE).bounds
        assertDp("row and divider", 65, browse.height)
        assertDp("rests where the grid did", 891 * 0.4f + 4, browse.top)
        rule.node(AttachTags.RECENT).assertIsDisplayed()
        rule.onNodeWithText("Report.pdf").assertIsDisplayed()
        assertEquals(3, rule.onAllNodesWithTag(AttachTags.FILE_ROW, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    private fun assertDp(message: String, expected: Float, actual: androidx.compose.ui.unit.Dp) = assertDp(message, expected.dp, actual)

    @Test fun shots() {
        if (dir == null) return
        var dark by mutableStateOf(false)
        var state by mutableStateOf(0)
        rule.setContent {
            com.slopus.happy.ui.theme.HappyTheme(preference = if (dark) com.slopus.happy.ui.theme.ThemePreference.Dark else com.slopus.happy.ui.theme.ThemePreference.Light) {
                // A fresh sheet for each state.
                androidx.compose.runtime.key(state, dark) {
                    when (state) {
                        0 -> SheetUnderTest()
                        1 -> {
                            val selection = remember { AttachSelection(20).apply { listOf(0, 2, 5).forEach { toggle(fakeGallery()[it].picked()) } } }
                            SheetUnderTest(selection = selection)
                        }
                        2 -> SheetUnderTest(startTab = AttachTabKind.Files)
                        else -> SheetUnderTest(content = GalleryContent(GalleryAccess.None))
                    }
                }
            }
        }
        for (theme in listOf(false, true)) {
            for ((index, name) in listOf("gallery", "picked", "files", "access").withIndex()) {
                dark = theme
                state = index
                rule.waitForIdle()
                shot(name, theme)
            }
        }
    }
}

/** The same sheet on a Galaxy Z Fold7's inner screen: 640 wide at most, centred, four columns. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w750dp-h832dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachSheetFoldTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `the sheet keeps Material's 640 and centres`() {
        rule.setHappyContent { SheetUnderTest() }
        rule.waitForIdle()
        val sheet = rule.node(AttachTags.SHEET).bounds
        assertDp("sheet", 640, sheet.width)
        assertDp("centred", 55, sheet.left)
        val cells = rule.onAllNodesWithTag(AttachTags.CELL, useUnmergedTree = true)
        val side = AttachSpec.cell(640.dp, 4)
        assertDp("cell", side, cells[0].bounds.width)
        assertDp("four across", cells[0].bounds.top, cells[3].bounds.top)
        assertTrue(cells[4].bounds.top > cells[0].bounds.bottom)
        assertDp("tab bar foot", 832, rule.node(AttachTags.TAB_BAR).bounds.bottom)
        System.getenv("HAPPY_SHOTS_DIR")?.let(::File)?.let { dir ->
            dir.mkdirs()
            rule.mainClock.advanceTimeBy(1_000)
            val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
            File(dir, "attach-fold-light.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
