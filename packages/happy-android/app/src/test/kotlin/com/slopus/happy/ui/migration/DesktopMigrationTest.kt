package com.slopus.happy.ui.migration

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import kotlinx.serialization.json.put
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeListInputs
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.home.HomeSnapshot
import com.slopus.happy.ui.home.HomeStateTags
import com.slopus.happy.ui.home.HomeUpdate
import com.slopus.happy.ui.home.deriveHomeList
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset

private const val PHONE_HEIGHT = 891

/**
 * The Happy CLI home's migration card and its screen (iOS ea1a0902f): the
 * card leads the list in its group in place of What's new, by path; × hides
 * that path's card on this phone, an agent connection hides it; the screen
 * lays out as iOS's MigrationScreenLayout on the first screens' column.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DesktopMigrationTest {
    @get:Rule
    val rule = createComposeRule()

    private val taps = mutableListOf<String>()

    private fun agent(revoked: Boolean = false) = AgentConnection(id = "a", name = "Studio", revoked = revoked, addedAt = 0)

    private fun home(machines: List<com.slopus.happy.model.Machine>) = deriveHomeList(
        HomeListInputs(
            HomeSnapshot(listOf(session("s", metadata = metadata { put("machineId", machines.first().id) }, active = true, lastMessageSentAt = 1)), machines),
            SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet(),
        ),
        ZoneOffset.UTC,
        LocalDate.of(2026, 11, 4),
    )

    private fun shot(name: String) {
        rule.waitForIdle()
        val dir = File("build/sweep-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun thePathFollowsTheAccountsComputersAndAnAgentConnectionHidesIt() {
        assertFalse(home(listOf(machine("m1", machineMetadata()))).hasServerAgent)
        assertTrue(home(listOf(machine("m1", machineMetadata()), machine("r1", machineMetadata { put("machineKind", "rig") }))).hasServerAgent)

        assertEquals(MigrationPath.Desktop, MigrationPath.shown(emptyList(), serverAgent = false, closed = emptySet()))
        assertEquals(MigrationPath.AgentConnection, MigrationPath.shown(emptyList(), serverAgent = true, closed = emptySet()))
        assertNull(MigrationPath.shown(listOf(agent()), serverAgent = false, closed = emptySet()))
        // A revoked pairing no longer reaches anything.
        assertEquals(MigrationPath.Desktop, MigrationPath.shown(listOf(agent(revoked = true)), serverAgent = false, closed = emptySet()))
        assertNull(MigrationPath.shown(emptyList(), serverAgent = false, closed = setOf(MigrationPath.Desktop)))
        // Closing one path's card leaves the other's.
        assertEquals(MigrationPath.AgentConnection, MigrationPath.shown(emptyList(), serverAgent = true, closed = setOf(MigrationPath.Desktop)))
    }

    @Test
    fun aClosedCardStaysClosedOnThisPhone() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences(DesktopMigrationCards.PREFS_NAME, Context.MODE_PRIVATE)
        val cards = DesktopMigrationCards(prefs)
        assertEquals(emptySet<MigrationPath>(), cards.closed.value)
        cards.close(MigrationPath.AgentConnection)
        assertEquals(setOf(MigrationPath.AgentConnection), cards.closed.value)
        assertTrue(prefs.getBoolean("agentConnection-migration-card-closed", false))
        assertEquals(setOf(MigrationPath.AgentConnection), DesktopMigrationCards(prefs).closed.value)
    }

    /** iOS DesktopCardLayout: icon level with the title's first line, words short of the 44 close in the top end corner. */
    @Test
    fun theCardLeadsHomeInPlaceOfWhatsNew() {
        val current = home(listOf(machine("m1", machineMetadata(), active = false), machine("m2", machineMetadata(), active = false)))
        val actions = HomeScreenActions(
            onSettings = {}, onNewSession = {}, onTroubleshoot = {}, onOpenUrl = {}, onWhatsNew = { taps += "whatsNew" },
            onMigration = { taps += "open:${it.wire}" }, onCloseMigration = { taps += "close:${it.wire}" },
        )
        val callbacks = HomeListCallbacks(
            onOpen = {}, onMenu = {}, onArchive = {}, onSetArchiveHidden = {}, onToggleProject = {},
            onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
        )
        rule.setHappyContent {
            HomeScreen(current, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, actions, update = HomeUpdate.Changelog, migration = MigrationPath.Desktop)
        }
        rule.node(HomeStateTags.CHANGELOG_BANNER).assertDoesNotExist()
        val card = rule.node(DesktopCardTags.CARD).bounds
        val offline = rule.node(HomeStateTags.OFFLINE_BANNER).bounds
        assertTrue("the card above the offline plaque", card.bottom <= offline.top)
        assertTrue("both above the rows", offline.bottom <= rule.node(FlatRowTags.ROW).bounds.top)

        val icon = rule.node(DesktopCardTags.ICON).bounds
        val title = rule.node(DesktopCardTags.TITLE).bounds
        val body = rule.node(DesktopCardTags.BODY).bounds
        val close = rule.node(DesktopCardTags.CLOSE).bounds
        assertDp("icon 16 in", card.left + 16.dp, icon.left)
        assertDp("icon 32", 32, icon.width)
        assertDp("icon level with the title's 22 first line", title.top + 11.dp, (icon.top + icon.bottom) / 2)
        assertDp("title 16 down", card.top + 16.dp, title.top)
        assertDp("title 12 after the icon", icon.right + 12.dp, title.left)
        assertDp("body 2 under the title", title.bottom + 2.dp, body.top)
        assertDp("close 44", 44, close.width)
        assertDp("close 4 from the top", card.top + 4.dp, close.top)
        assertDp("close 4 from the end", card.right - 4.dp, close.right)
        assertTrue("words stop short of close", body.right <= close.left + 0.34.dp && title.right <= close.left + 0.34.dp)
        assertDp("16 under the body", body.bottom + 16.dp, card.bottom)

        // One button for TalkBack: its title, then its words, with Close among its actions.
        val spoken = rule.node(DesktopCardTags.CARD).fetchSemanticsNode()
        val merged = rule.onNodeWithText("Happy now on desktop", substring = true).fetchSemanticsNode().config
        assertTrue(merged.getOrNull(SemanticsProperties.Text).orEmpty().joinToString().contains("Please migrate!"))
        assertEquals(listOf("Close"), spoken.config.getOrNull(SemanticsActions.CustomActions)?.map { it.label })
        rule.assertActionsLabelled()

        rule.node(DesktopCardTags.CLOSE).performClick()
        rule.node(DesktopCardTags.CARD).performClick()
        assertEquals(listOf("close:desktop", "open:desktop"), taps)
        shot("w1-home-card-light")
    }

    @Test
    fun theDirectPathsCardSaysSo() {
        rule.setHappyContent(dark = true) {
            DesktopMigrationCard(MigrationPath.AgentConnection, {}, {})
        }
        rule.onNodeWithText("Migrate to direct connection").assertExists()
        rule.onNodeWithText("You’re using Happy Agent through the Happy server. Connect directly for the lowest latency and newest features.").assertExists()
    }

    private fun screen(path: MigrationPath, dark: Boolean = false) {
        rule.setHappyContent(dark = dark) {
            DesktopMigrationScreen(
                path = path,
                scanning = false,
                onBack = { taps += "back" },
                onScan = { taps += "scan" },
                onOpenSite = { taps += "site" },
                onLearnMore = { taps += "learn" },
            )
        }
        rule.mainClock.advanceTimeBy(5_000)
    }

    /** iOS MigrationScreenLayout, the Happy Desktop path. */
    @Test
    fun theDesktopPathLaysOutAsIos() {
        screen(MigrationPath.Desktop)
        rule.node(HeaderTags.BAR).assertExists()
        val art = rule.node(DesktopMigrationTags.ART).bounds
        val title = rule.node(DesktopMigrationTags.TITLE).bounds
        val body = rule.node(DesktopMigrationTags.BODY).bounds
        val number0 = rule.node("${DesktopMigrationTags.NUMBER}.0").bounds
        val step0 = rule.node("${DesktopMigrationTags.STEP}.0").bounds
        val site = rule.node(DesktopMigrationTags.SITE).bounds
        val step1 = rule.node("${DesktopMigrationTags.STEP}.1").bounds
        val scan = rule.node(DesktopMigrationTags.SCAN).bounds
        val learn = rule.node(DesktopMigrationTags.LEARN_MORE).bounds
        val server = rule.node(DesktopMigrationTags.SERVER).bounds
        rule.node(DesktopMigrationTags.DIAGRAM).assertDoesNotExist()

        assertDp("art under the bar", 64, art.top)
        assertDp("art 72", 72, art.width)
        assertDp("title 16 under the art", art.bottom + 16.dp, title.top)
        assertDp("line 8 under the title", title.bottom + 8.dp, body.top)
        assertDp("steps 20 under the line", body.bottom + 20.dp, step0.top)
        assertDp("the dot 1 down, level with the first line", step0.top + 1.dp, number0.top)
        assertDp("dot 22", 22, number0.width)
        assertDp("the column 24 in", 24, number0.left)
        assertDp("words 12 after the dot", number0.right + 12.dp, step0.left)
        assertDp("the site's words start on the step's edge", step0.left - 14.dp, site.left)
        assertDp("site under its step", step0.bottom, site.top)
        assertDp("site a 40 target", 40, site.height)
        assertDp("next step 12 under", site.bottom + 12.dp, step1.top)
        rule.onNodeWithText("Choose Link\u00A0Mobile\u00A0App during onboarding.\nOr go to Settings\u00A0›\u00A0Mobile\u00A0Access.").assertExists()
        assertTrue("scan at least 20 under the steps", scan.top >= step1.bottom + 20.dp - 0.34.dp)
        assertDp("learn more 4 under scan", scan.bottom + 4.dp, learn.top)
        assertDp("learn more a 40 target", 40, learn.height)
        assertDp("server 8 under learn more", learn.bottom + 8.dp, server.top)
        assertDp("the closed section's foot on the window's", PHONE_HEIGHT.dp, server.bottom)
        for ((name, box) in listOf("art" to art, "title" to title, "scan" to scan, "learn more" to learn, "server" to server)) {
            assertDp("$name centred", (PHONE_WIDTH / 2f).dp, (box.left + box.right) / 2)
        }
        rule.assertActionsLabelled()
        shot("w1-screen-desktop-light")

        // Opened, the paragraphs grow under it, centred, 4 down.
        rule.node(DesktopMigrationTags.SERVER_PARAGRAPHS).assertDoesNotExist()
        rule.node(DesktopMigrationTags.SERVER).performClick()
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithText("To set up a new server, ask Chief of Staff.").performScrollTo().assertExists()
        val opened = rule.node(DesktopMigrationTags.SERVER).bounds
        assertDp("paragraphs 4 under the title", opened.bottom + 4.dp, rule.onNodeWithText("In Happy Desktop, select the remote server and scan its code the same way.").bounds.top)
        shot("w1-screen-desktop-server-open-light")
        rule.node(DesktopMigrationTags.SERVER).performClick()
        rule.mainClock.advanceTimeBy(1_000)
        rule.node(DesktopMigrationTags.SERVER_PARAGRAPHS).assertDoesNotExist()

        rule.node(DesktopMigrationTags.SCAN).performClick()
        rule.node(DesktopMigrationTags.LEARN_MORE).performClick()
        rule.onNodeWithContentDescription("Download from happy.engineering").performClick()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("scan", "learn", "site", "back"), taps)
    }

    /** iOS ConnectionDiagramLayout, on the direct connection's path: before and after, then the settings step. */
    @Test
    fun theDirectPathShowsBeforeAndAfter() {
        screen(MigrationPath.AgentConnection, dark = true)
        val body = rule.node(DesktopMigrationTags.BODY).bounds
        val diagram = rule.node(DesktopMigrationTags.DIAGRAM).bounds
        val step0 = rule.node("${DesktopMigrationTags.STEP}.0").bounds
        val step1 = rule.node("${DesktopMigrationTags.STEP}.1").bounds
        assertDp("diagram 20 under the line", body.bottom + 20.dp, diagram.top)
        assertDp("the column's width", PHONE_WIDTH.dp - 48.dp, diagram.width)
        assertDp("steps 20 under the diagram", diagram.bottom + 20.dp, step0.top)
        assertDp("no site on this path", step0.bottom + 12.dp, step1.top)
        rule.node(DesktopMigrationTags.SITE).assertDoesNotExist()
        rule.onNodeWithText("Go to Settings\u00A0›\u00A0Mobile\u00A0Access.").assertExists()
        rule.onNodeWithContentDescription("Current connection: your phone reaches your computer through the Happy server", substring = true).assertExists()
        rule.assertActionsLabelled()
        shot("w1-screen-direct-dark")
    }

    /** On a tablet the column stays 440 and centred. */
    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletTheColumnIsHeld() {
        screen(MigrationPath.AgentConnection)
        val diagram = rule.node(DesktopMigrationTags.DIAGRAM).bounds
        assertDp("440 wide", 440, diagram.width)
        assertDp("centred", 640.dp, (diagram.left + diagram.right) / 2)
        shot("w1-screen-direct-tablet-light")
    }
}
