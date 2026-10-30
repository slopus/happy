package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.layout.ContentWidth
import com.slopus.happy.ui.layout.ProvideWindowLayout
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

/**
 * An agent connection's home on a wide window: the bar, the rows, the
 * search panel and the state pages are all held to one content width and
 * centred, rather than stretching to the glass, so a row's title and its
 * timestamp stay a readable line apart and every hitbox agrees.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = TABLET)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentHomeTabletTest {
    @get:Rule val rule = createComposeRule()

    private val actions = AgentHomeActions({}, {}, {}, {}, {}, {})
    private val accounts = AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true)))
    private val feed get() = AgentFeed.derive(AgentHomeLayoutTest.catalog(AgentHomeLayoutTest.sample))

    private fun show(feed: AgentFeed, status: AgentLinkStatus = AgentLinkStatus.Connected) = rule.setHappyContent {
        ProvideWindowLayout(Modifier.fillMaxSize()) {
            AgentHomeScreen("Studio", feed, status, accounts, actions, now = AgentHomeLayoutTest.NOW)
        }
    }

    /** The window is wider than the cap, so there is something to hold back. */
    private val cap = ContentWidth.tablet

    @Test
    fun theBarAndEveryRowAreHeldToOneContentWidthAndCentred() {
        show(feed)
        val inset = (TABLET_WIDTH.dp - cap) / 2
        val bar = rule.node(AgentHomeTags.BAR).bounds
        assertDp("the bar is capped", cap, bar.width)
        assertDp("the bar is centred", inset, bar.left)

        for (key in listOf("section-bots", "agent-ab1", "agent-at1", "agent-ap1")) {
            val row = rule.node(AgentHomeTags.row(key)).bounds
            assertDp("$key is capped", cap, row.width)
            assertDp("$key is centred", inset, row.left)
        }
        // The rows still keep their kind's exact height out here.
        assertDp("conversation height", 60, rule.node(AgentHomeTags.row("agent-ab1")).bounds.height)

        // The account menu and the actions sit inside the capped bar, not out at the glass.
        val menu = rule.node(AccountMenuTags.BUTTON).bounds
        val compose = rule.node(AgentHomeTags.COMPOSE).bounds
        assertTrue("the menu is inside the bar: $menu vs $bar", menu.left >= bar.left)
        assertTrue("compose is inside the bar: $compose vs $bar", compose.right <= bar.right)
    }

    @Test
    fun theSearchPanelAndItsRowsAreHeldToTheSameWidth() {
        show(feed)
        val inset = (TABLET_WIDTH.dp - cap) / 2
        rule.node(AgentHomeTags.SEARCH).performClick()
        rule.node(AgentSearchTags.FIELD).performTextInput("re")
        rule.waitForIdle()
        val row = rule.node(AgentSearchTags.result("agent-as1")).bounds
        assertDp("a result is capped", cap, row.width)
        assertDp("a result is centred", inset, row.left)
        // The panel's own surface still spans the window, so home never shows through beside it.
        assertDp("the panel spans the window", TABLET_WIDTH, rule.node(AgentSearchTags.RESULTS).bounds.width)
    }

    /** A wide render for review, written only when HAPPY_SHOTS_DIR is set. */
    @Test
    fun wideShot() {
        val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File) ?: return
        dir.mkdirs()
        show(feed)
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "tablet-home-1280.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun theStatePagesAreCappedToo() {
        show(AgentFeed.Empty, AgentLinkStatus.Connecting)
        // The column is the content width less its own 32 of air on each side, and centred in the window.
        val page = rule.node(AgentHomeTags.SPINNER).bounds
        assertDp("the state page is capped", cap - 64.dp, page.width)
        assertEquals("the state page is centred", (TABLET_WIDTH.dp - page.width).value / 2, page.left.value, 1f)
    }
}

private const val TABLET = "w1280dp-h800dp-xhdpi"
private const val TABLET_WIDTH = 1280
