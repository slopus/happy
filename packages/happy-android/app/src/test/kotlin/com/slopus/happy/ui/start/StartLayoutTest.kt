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
                    onConnect = { taps += "connect" },
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

    /** Start 48 above [bottom]; the logo centred in the space between [top] and Start. */
    private fun assertMiddle(logo: DpRect, connect: DpRect, bottom: Dp, top: Dp = 0.dp) {
        assertDp("start 48 above the bottom", bottom - 48.dp, connect.bottom)
        assertDp("logo centred above start", logo.top - top, connect.top - logo.bottom)
    }

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

        // Start 48 above the bottom, the logo centred in the space above it.
        val logo = rule.node(StartTags.LOGO).bounds
        assertDp("logo width", 220, logo.width)
        assertDp("logo keeps the logotype's aspect", (220f * 319f / 1200f).dp, logo.height)
        assertDp("logo centred across", (PHONE_WIDTH / 2f).dp, (logo.left + logo.right) / 2)
        assertMiddle(logo, connect, PHONE_HEIGHT.dp)
        rule.assertActionsLabelled()
    }

    /** Connect scans; everything else is in the ⋮ drop-down. */
    @Test
    fun theMenuHoldsTheOtherWaysIn() {
        show()
        rule.onNodeWithText("Start").performClick()
        for ((label, tap) in listOf(
            "Enter link manually" to "link",
            "Restore Legacy Account" to "restore",
            "Legacy Server" to "server",
        )) {
            rule.onNodeWithContentDescription("More").performClick()
            rule.node(StartTags.MENU).assertExists()
            rule.onNodeWithText(label).performClick()
            rule.node(StartTags.MENU).assertDoesNotExist()
            assertEquals(tap, taps.last())
        }
        assertEquals(listOf("connect", "link", "restore", "server"), taps)

        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("happy.example.com").assertExists()
        rule.onNodeWithText("Create account").assertDoesNotExist()
        // Nothing else: no account is made here, and help lives in Settings.
        rule.onNodeWithText("Get help").assertDoesNotExist()
    }

    /** Legacy Server names a custom server under it, and says nothing for the default one. */
    @Test
    fun theDefaultServerHasNoSubtitle() {
        show(server = null)
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Legacy Server").assertExists()
        rule.onNodeWithText("Default").assertDoesNotExist()
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
        assertMiddle(rule.node(StartTags.LOGO).bounds, rule.node(StartTags.CONNECT).bounds, (PHONE_HEIGHT - 48).dp, top = 24.dp)
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

    /** At font scale 2.0 Connect's label grows along the sp curve and the button with it; icons and the logo don't. */
    @Test
    fun largeText() {
        show(density = LARGE_TEXT)
        val connect = rule.node(StartTags.CONNECT).bounds
        val logo = rule.node(StartTags.LOGO).bounds
        assertTrue("connect holds its 2x line", connect.height >= with(LARGE_TEXT) { 22.sp.toDp() })
        assertDp("connect centred", (PHONE_WIDTH / 2f).dp, (connect.left + connect.right) / 2)
        assertMiddle(logo, connect, PHONE_HEIGHT.dp)
        assertDp("logo keeps its size", 220, logo.width)
        assertDp("more keeps its size", 48, rule.node(StartTags.MORE).bounds.width)
    }

    /** Large text on a short window: the screen scrolls from the top instead of squeezing. */
    @Test
    fun largeTextOnAShortWindowScrolls() {
        show(density = LARGE_TEXT, height = 120)
        val content = rule.node(StartTags.CONTENT).bounds
        assertDp("logo starts at the top", content.top, rule.node(StartTags.LOGO).bounds.top)
        rule.node(StartTags.CONNECT).performScrollTo()
        assertTrue("connect scrolls into view", rule.node(StartTags.CONNECT).bounds.bottom <= content.bottom + 0.34.dp)
    }

    @Test
    fun darkModeLaysOutTheSame() {
        show(dark = true)
        assertMiddle(rule.node(StartTags.LOGO).bounds, rule.node(StartTags.CONNECT).bounds, PHONE_HEIGHT.dp)
        assertDp("logo width", 220, rule.node(StartTags.LOGO).bounds.width)
    }
}
