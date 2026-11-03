package com.slopus.happy.ui.start

import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.width
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val PHONE_HEIGHT = 891
private val LARGE_TEXT = Density(3f, fontScale = 2f)

/** The first screen at phone size, at font scale 2.0 and inside the window's insets. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StartLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val taps = mutableListOf<String>()
    private lateinit var view: View

    private fun show(dark: Boolean = false, density: Density? = null, height: Int? = null, server: String? = "happy.example.com") {
        rule.setHappyContent(dark = dark) {
            view = LocalView.current
            val screen = @Composable {
                StartScreen(
                    connecting = false,
                    customServerLabel = server,
                    onStart = { taps += "start" },
                    onEnterLink = { taps += "link" },
                    onRestore = { taps += "restore" },
                    onServer = { taps += "server" },
                )
            }
            val sized = @Composable {
                if (height != null) Box(Modifier.fillMaxWidth().height(height.dp)) { screen() } else screen()
            }
            if (density != null) CompositionLocalProvider(LocalDensity provides density, content = sized) else sized()
        }
    }

    /** Start 48 above [bottom]; the slides centred between ⋮'s row (52 under [top]) and Start. */
    private fun assertMiddle(gallery: DpRect, connect: DpRect, bottom: Dp, top: Dp = 0.dp) {
        assertDp("start 48 above the bottom", bottom - 48.dp, connect.bottom)
        assertDp("slides centred above start", gallery.top - (top + 52.dp), connect.top - gallery.bottom)
    }

    private val gallery get() = rule.node(StartGalleryTags.GALLERY).bounds

    @Test
    fun phoneLayout() {
        show()
        // No header: the gradient fills the window, and so does the content with no insets.
        rule.node(HeaderTags.BAR).assertDoesNotExist()
        assertBox("background", rule.node(StartTags.BACKGROUND).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, PHONE_HEIGHT.dp)
        assertBox("content", rule.node(StartTags.CONTENT).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, PHONE_HEIGHT.dp)

        // ⋮ top right, a 48 target 4 in.
        assertBox("more", rule.node(StartTags.MORE).bounds, (PHONE_WIDTH - 4 - 48).dp, 4.dp, 48.dp, 48.dp)

        // Connect: centred across, as wide as its label but at least 200.
        val connect = rule.node(StartTags.CONNECT).bounds
        assertDp("connect width", 200, connect.width)
        assertDp("connect height", 50, connect.height)
        assertDp("connect centred", (PHONE_WIDTH / 2f).dp, (connect.left + connect.right) / 2)

        // The logotype, small, centred on ⋮'s row.
        val logo = rule.node(StartTags.LOGO).bounds
        assertDp("logo width", 88, logo.width)
        assertDp("logo keeps the logotype's aspect", (88f * 319f / 1200f).dp, logo.height)
        assertDp("logo centred across", (PHONE_WIDTH / 2f).dp, (logo.left + logo.right) / 2)
        assertDp("logo on more's row", 4 + 24, (logo.top + logo.bottom) / 2)

        // Start 48 above the bottom, the slides centred in the space above it.
        assertMiddle(gallery, connect, PHONE_HEIGHT.dp)
        // The art's 96 square, then the title 24 under it and its line 8 under that, in a 24-inset column.
        val art = rule.node(StartGalleryTags.art(0)).bounds
        assertBox("art", art, ((PHONE_WIDTH - 96) / 2f).dp, gallery.top, 96.dp, 96.dp)
        val title = rule.node(StartGalleryTags.title(0)).bounds
        assertBox("title", title, 24.dp, art.bottom + 24.dp, (PHONE_WIDTH - 48).dp, title.height)
        val body = rule.node(StartGalleryTags.body(0)).bounds
        assertDp("body 8 under the title", title.bottom + 8.dp, body.top)
        // Four dots, 24 targets, centred 24 under the tallest slide's words.
        val dots = rule.node(StartGalleryTags.DOTS).bounds
        assertBox("dots", dots, ((PHONE_WIDTH - 96) / 2f).dp, dots.top, 96.dp, 24.dp)
        assertTrue("dots under the words", dots.top >= body.bottom + 24.dp - 0.34.dp)
        assertDp("dots end the slides", gallery.bottom, dots.bottom)
        rule.assertActionsLabelled()
    }

    /** Start goes on; everything else is in the ⋮ drop-down. */
    @Test
    fun theMenuHoldsTheOtherWaysIn() {
        show()
        rule.onNodeWithText("Start").performClick()
        for ((label, tap) in listOf(
            "Enter link manually" to "link",
            "Restore Happy CLI account" to "restore",
            "Happy CLI server" to "server",
        )) {
            rule.onNodeWithContentDescription("More").performClick()
            rule.node(StartTags.MENU).assertExists()
            rule.onNodeWithText(label).performClick()
            rule.node(StartTags.MENU).assertDoesNotExist()
            assertEquals(tap, taps.last())
        }
        assertEquals(listOf("start", "link", "restore", "server"), taps)

        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("happy.example.com").assertExists()
        // No account is made here: a Happy account only ever comes from a terminal's code.
        rule.onNodeWithText("Create account").assertDoesNotExist()
        // Help last, under a divider, as iOS's StartMenu.
        rule.node(StartTags.HELP).assertExists()
        assertTrue("help under the server", rule.node(StartTags.HELP).bounds.top >= rule.node(StartTags.SERVER).bounds.bottom)
        rule.onNodeWithText("Get help").performClick()
        rule.node(StartTags.MENU).assertDoesNotExist()
        rule.onNodeWithText("Stuck? Come ask us.").assertExists()
        // One under another, Cancel last: side by side "Browse known issues" broke a letter at a time.
        val discord = rule.onNodeWithText("Ask on Discord").bounds
        val issues = rule.onNodeWithText("Browse known issues").bounds
        val cancel = rule.onNodeWithText("Cancel").bounds
        assertTrue("stacked", discord.bottom <= issues.top && issues.bottom <= cancel.top)
        assertTrue("on one line", issues.height < discord.height * 1.5f)
        assertEquals(listOf("start", "link", "restore", "server"), taps)
    }

    /** Happy CLI server names a custom server under it, and "Default" for the default one, as iOS. */
    @Test
    fun theDefaultServerSaysDefault() {
        show(server = null)
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Happy CLI server").assertExists()
        rule.onNodeWithText("Default").assertExists()
    }

    /** The content keeps out of the status and navigation bars; the gradient still fills the window behind them. */
    @Test
    fun contentStaysInsideTheInsets() {
        show()
        rule.runOnIdle {
            val px = view.resources.displayMetrics.density
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, (24 * px).toInt(), 0, 0))
                .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, (48 * px).toInt()))
                .build()
            ViewCompat.dispatchApplyWindowInsets(view, insets)
        }
        rule.waitForIdle()
        assertBox("background", rule.node(StartTags.BACKGROUND).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, PHONE_HEIGHT.dp)
        assertBox("content", rule.node(StartTags.CONTENT).bounds, 0.dp, 24.dp, PHONE_WIDTH.dp, (PHONE_HEIGHT - 24 - 48).dp)
        assertDp("more under the status bar", 24 + 4, rule.node(StartTags.MORE).bounds.top)
        assertMiddle(gallery, rule.node(StartTags.CONNECT).bounds, (PHONE_HEIGHT - 48).dp, top = 24.dp)
    }

    /** Nothing here takes text: a keyboard (a dialog's) leaves the screen where it is. */
    @Test
    fun theKeyboardDoesNotMoveIt() {
        show()
        val before = rule.node(StartTags.CONNECT).bounds
        rule.runOnIdle {
            val px = view.resources.displayMetrics.density
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, (300 * px).toInt()))
                .setVisible(WindowInsetsCompat.Type.ime(), true)
                .build()
            ViewCompat.dispatchApplyWindowInsets(view, insets)
        }
        rule.waitForIdle()
        assertBox("content", rule.node(StartTags.CONTENT).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, PHONE_HEIGHT.dp)
        assertEquals(before, rule.node(StartTags.CONNECT).bounds)
    }

    /** At font scale 2.0 the words and Start's label grow along the sp curve; the title stops at 1.2; icons, the art and the logo don't grow. */
    @Test
    fun largeText() {
        show(density = LARGE_TEXT)
        val connect = rule.node(StartTags.CONNECT).bounds
        val logo = rule.node(StartTags.LOGO).bounds
        assertTrue("connect holds its 2x line", connect.height >= with(LARGE_TEXT) { 22.sp.toDp() })
        assertDp("connect centred", (PHONE_WIDTH / 2f).dp, (connect.left + connect.right) / 2)
        assertDp("logo keeps its size", 88, logo.width)
        assertDp("art keeps its size", 96, rule.node(StartGalleryTags.art(0)).bounds.width)
        assertDp("more keeps its size", 48, rule.node(StartTags.MORE).bounds.width)
        // At least 16 kept between more's row and the slides, and between them and Start.
        assertTrue("16 under more's row", gallery.top >= (52 + 16).dp - 0.34.dp)
        assertTrue("16 over start", connect.top - gallery.bottom >= 16.dp - 0.34.dp)
    }

    /** Large text on a short window: the screen scrolls from the top instead of squeezing. */
    @Test
    fun largeTextOnAShortWindowScrolls() {
        show(density = LARGE_TEXT, height = 120)
        val content = rule.node(StartTags.CONTENT).bounds
        assertTrue("logo on the top row", rule.node(StartTags.LOGO).bounds.top < content.top + 52.dp)
        rule.node(StartTags.CONNECT).performScrollTo()
        assertTrue("connect scrolls into view", rule.node(StartTags.CONNECT).bounds.bottom <= content.bottom + 0.34.dp)
    }

    @Test
    fun darkModeLaysOutTheSame() {
        show(dark = true)
        assertMiddle(gallery, rule.node(StartTags.CONNECT).bounds, PHONE_HEIGHT.dp)
        assertDp("logo width", 88, rule.node(StartTags.LOGO).bounds.width)
    }
}
