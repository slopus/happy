package com.slopus.happy.ui.migration

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.CompositionLocalProvider
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
import com.slopus.happy.ui.connect.ConnectFlow
import com.slopus.happy.ui.connect.LocalAgentPairing
import com.slopus.happy.ui.connect.LocalQrScanner
import com.slopus.happy.ui.connect.QrScanner
import com.slopus.happy.ui.connect.ScanResult
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
import java.util.concurrent.CopyOnWriteArrayList

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

        // PostHog's flag off, unknown or failed: no card on either path.
        assertNull(MigrationPath.shown(false, emptyList(), serverAgent = false, closed = emptySet()))
        assertNull(MigrationPath.shown(false, emptyList(), serverAgent = true, closed = emptySet()))
        assertEquals(MigrationPath.Desktop, MigrationPath.shown(true, emptyList(), serverAgent = false, closed = emptySet()))
        assertEquals(MigrationPath.AgentConnection, MigrationPath.shown(true, emptyList(), serverAgent = true, closed = emptySet()))
        assertNull(MigrationPath.shown(true, listOf(agent()), serverAgent = false, closed = emptySet()))
        // A revoked pairing no longer reaches anything.
        assertEquals(MigrationPath.Desktop, MigrationPath.shown(true, listOf(agent(revoked = true)), serverAgent = false, closed = emptySet()))
        assertNull(MigrationPath.shown(true, emptyList(), serverAgent = false, closed = setOf(MigrationPath.Desktop)))
        // Closing one path's card leaves the other's.
        assertEquals(MigrationPath.AgentConnection, MigrationPath.shown(true, emptyList(), serverAgent = true, closed = setOf(MigrationPath.Desktop)))
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

    /** iOS MigrationScreenLayout (7c471796f), the Happy Desktop path: three steps, 22 from what each shows. */
    @Test
    fun theDesktopPathLaysOutAsIos() {
        screen(MigrationPath.Desktop)
        rule.node(HeaderTags.BAR).assertExists()
        val art = rule.node(DesktopMigrationTags.ART).bounds
        val title = rule.node(DesktopMigrationTags.TITLE).bounds
        val body = rule.node(DesktopMigrationTags.BODY).bounds
        val number0 = rule.node("${DesktopMigrationTags.NUMBER}.0").bounds
        val step0 = rule.node("${DesktopMigrationTags.STEP}.0").bounds
        val upToDate = rule.node("${DesktopMigrationTags.DETAIL}.0").bounds
        val site = rule.node(DesktopMigrationTags.SITE).bounds
        val step1 = rule.node("${DesktopMigrationTags.STEP}.1").bounds
        val number2 = rule.node("${DesktopMigrationTags.NUMBER}.2").bounds
        val step2 = rule.node("${DesktopMigrationTags.STEP}.2").bounds
        val detail = rule.node("${DesktopMigrationTags.DETAIL}.2").bounds
        val scan = rule.node(DesktopMigrationTags.SCAN).bounds
        val learn = rule.node(DesktopMigrationTags.LEARN_MORE).bounds

        assertDp("art under the bar", 64, art.top)
        assertDp("art 72", 72, art.width)
        assertDp("title 16 under the art", art.bottom + 16.dp, title.top)
        assertDp("line 8 under the title", title.bottom + 8.dp, body.top)
        assertDp("steps 20 under the line", body.bottom + 20.dp, step0.top)
        assertDp("the dot 1 down, level with the first line", step0.top + 1.dp, number0.top)
        assertDp("dot 22", 22, number0.width)
        assertDp("the column 24 in", 24, number0.left)
        assertDp("words 12 after the dot", number0.right + 12.dp, step0.left)
        assertDp("up to date 10 under the first step's words", step0.bottom + 10.dp, upToDate.top)
        rule.onNodeWithText("Make sure Happy Desktop is up to date.").assertExists()
        assertDp("the site's words start on the step's edge", step0.left - 14.dp, site.left)
        assertDp("site under up to date", upToDate.bottom, site.top)
        assertDp("site a 40 target", 40, site.height)
        assertDp("next step 22 under the site's words", site.top + 30.dp + 22.dp, step1.top)
        rule.onNodeWithText("Choose Link\u00A0Mobile\u00A0App during onboarding.\nOr go to Settings\u00A0›\u00A0Mobile\u00A0Access.").assertExists()
        assertDp("the server's step 22 under", step1.bottom + 22.dp, step2.top)
        assertDp("its dot level with it", step2.top + 1.dp, number2.top)
        rule.onNodeWithText("Using Happy on a server?").assertExists()
        assertDp("its detail 10 under its words", step2.bottom + 10.dp, detail.top)
        assertDp("the detail on the words' edge", step2.left, detail.left)
        rule.onNodeWithText("Select it in Happy Desktop and scan its code.\nTo set up a new remote server, just ask the Chief of Staff bot in Happy Desktop.").assertExists()
        assertTrue("scan at least 20 under the detail", scan.top >= detail.bottom + 20.dp - 0.34.dp)
        assertDp("learn more 4 under scan", scan.bottom + 4.dp, learn.top)
        assertDp("learn more a 40 target", 40, learn.height)
        assertDp("learn more's foot on the window's", PHONE_HEIGHT.dp, learn.bottom)
        for ((name, box) in listOf("art" to art, "title" to title, "scan" to scan, "learn more" to learn)) {
            assertDp("$name centred", (PHONE_WIDTH / 2f).dp, (box.left + box.right) / 2)
        }
        // The diagram and the server's section that opened in place are gone (iOS e601c6dc1).
        rule.onNodeWithText("Running Happy on a server?").assertDoesNotExist()
        rule.onNodeWithText("Current connection", substring = true).assertDoesNotExist()
        rule.assertActionsLabelled()
        shot("w25-screen-desktop-light")

        rule.node(DesktopMigrationTags.SCAN).performClick()
        rule.node(DesktopMigrationTags.LEARN_MORE).performClick()
        rule.onNodeWithContentDescription("Download from happy.engineering").performClick()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("scan", "learn", "site", "back"), taps)
    }

    /** The direct connection's path: open Happy Desktop, its settings, then the server's case. */
    @Test
    fun theDirectPathListsTheServerCaseThird() {
        screen(MigrationPath.AgentConnection, dark = true)
        val body = rule.node(DesktopMigrationTags.BODY).bounds
        val step0 = rule.node("${DesktopMigrationTags.STEP}.0").bounds
        val upToDate = rule.node("${DesktopMigrationTags.DETAIL}.0").bounds
        val step1 = rule.node("${DesktopMigrationTags.STEP}.1").bounds
        val step2 = rule.node("${DesktopMigrationTags.STEP}.2").bounds
        val detail = rule.node("${DesktopMigrationTags.DETAIL}.2").bounds
        assertDp("steps 20 under the line", body.bottom + 20.dp, step0.top)
        assertDp("up to date 10 under the first step", step0.bottom + 10.dp, upToDate.top)
        rule.onNodeWithText("Make sure Happy Desktop is up to date.").assertExists()
        assertDp("no site on this path, 22 from up to date to the next step", upToDate.bottom + 22.dp, step1.top)
        assertDp("22 to the server's step", step1.bottom + 22.dp, step2.top)
        assertDp("its detail 10 under", step2.bottom + 10.dp, detail.top)
        rule.node(DesktopMigrationTags.SITE).assertDoesNotExist()
        rule.onNodeWithText("Go to Settings\u00A0›\u00A0Mobile\u00A0Access.").assertExists()
        rule.onNodeWithText("Using Happy on a server?").assertExists()
        rule.assertActionsLabelled()
        shot("w25-screen-direct-dark")
    }

    /** On a tablet the column stays 440 and centred. */
    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletTheColumnIsHeld() {
        screen(MigrationPath.AgentConnection)
        val number = rule.node("${DesktopMigrationTags.NUMBER}.0").bounds
        val detail = rule.node("${DesktopMigrationTags.DETAIL}.2").bounds
        assertDp("440 wide, centred", 640.dp - 220.dp, number.left)
        assertDp("the detail reaches the column's end", 640.dp + 220.dp, detail.right)
        shot("w25-screen-direct-tablet-light")
    }

    /** Words taller than the window push the button 20 under the detail, and the page scrolls to Learn more. */
    @Test
    @Config(qualifiers = "w411dp-h500dp-xxhdpi")
    fun tooTallItScrolls() {
        screen(MigrationPath.Desktop)
        val detail = rule.node("${DesktopMigrationTags.DETAIL}.2").bounds
        rule.node(DesktopMigrationTags.LEARN_MORE).performScrollTo()
        val scan = rule.node(DesktopMigrationTags.SCAN).bounds
        val learn = rule.node(DesktopMigrationTags.LEARN_MORE).bounds
        val after = rule.node("${DesktopMigrationTags.DETAIL}.2").bounds
        assertDp("scan 20 under the detail", after.bottom + 20.dp, scan.top)
        assertTrue("the page scrolled", after.top < detail.top)
        assertTrue("learn more on the screen", learn.bottom <= 500.dp + 0.34.dp)
    }

    private val scans = ArrayDeque<String>()
    private val linked = CopyOnWriteArrayList<String>()
    private val paired = CopyOnWriteArrayList<String>()
    private lateinit var scan: ConnectFlow

    private fun scanner() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides QrScanner { ScanResult.Scanned(scans.removeFirst()) }, LocalAgentPairing provides { code, _ -> paired += code }) {
                scan = rememberMigrationScan(approve = { url -> linked += url })
            }
        }
    }

    private val serverCode = "This is a Happy server code"

    /** A direct connection's code pairs at once, with nothing to confirm. */
    @Test
    fun aDirectCodePairs() {
        scanner()
        scans += "happy://direct?eyJ2IjoxfQ"
        rule.runOnIdle { scan.scan() }
        rule.waitUntil { paired.isNotEmpty() }
        assertEquals(listOf("happy://direct?eyJ2IjoxfQ"), paired)
        rule.onNodeWithText(serverCode).assertDoesNotExist()
        assertTrue(linked.isEmpty())
    }

    /** A Happy server's code says it isn't direct; Link anyway approves it for this account, Cancel leaves it. */
    @Test
    fun aHappyServerCodeAsksFirst() {
        scanner()
        scans += "happy://terminal?abc"
        rule.runOnIdle { scan.scan() }
        rule.onNodeWithText(serverCode).assertExists()
        rule.onNodeWithText(
            "This links your computer through the Happy server, not directly. If Happy Desktop shows a direct connection code, scan that instead. You may need to update Happy Desktop.",
        ).assertExists()
        rule.onNodeWithText("Cancel").performClick()
        rule.onNodeWithText(serverCode).assertDoesNotExist()
        assertTrue(linked.isEmpty())

        scans += "happy://terminal?def"
        rule.runOnIdle { scan.scan() }
        rule.onNodeWithText("Link anyway").performClick()
        rule.waitUntil { linked.isNotEmpty() }
        assertEquals(listOf("happy://terminal?def"), linked)
        assertTrue(paired.isEmpty())
    }
}
