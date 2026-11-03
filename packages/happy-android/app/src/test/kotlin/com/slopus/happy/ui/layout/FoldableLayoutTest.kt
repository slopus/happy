package com.slopus.happy.ui.layout

import android.graphics.Bitmap
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.artifacts.ArtifactCatalogFeed
import com.slopus.happy.artifacts.ArtifactSummary
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Todo
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.artifacts.ArtifactsScreen
import com.slopus.happy.ui.artifacts.ArtifactsTags
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatListTags
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.components.GlassBarTags
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeLayoutTest
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.connection.AgentPlacesTags
import com.slopus.happy.ui.connection.PlaceRead
import com.slopus.happy.ui.connection.SurfaceBody
import com.slopus.happy.ui.connection.SurfaceScreen
import com.slopus.happy.ui.conversation.AgentPageActions
import com.slopus.happy.ui.conversation.AgentPageFixtures
import com.slopus.happy.ui.conversation.AgentPageScreen
import com.slopus.happy.ui.conversation.AgentPageTags
import com.slopus.happy.ui.conversation.ConversationComposerTags
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeListInputs
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.home.HomeSnapshot
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.home.deriveHomeList
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsFixtures
import com.slopus.happy.ui.settings.SettingsScreen
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The layout tokens ([ContentTokens]) as the screens lay them out, at a
 * phone (411), a Galaxy Z Fold7's inner screen upright (750) and on its side
 * (832, still one pane under the 840 shell) and a tablet
 * (1280): content keeps one keyline either side, [keyline] in from the
 * window, and every top bar's leading and trailing glyphs (the visible
 * 24 dp icon or 32 dp avatar, not its 48 dp target) sit on it, over the
 * cards, settings groups and message text below. Home's bars sit a card's
 * inset further in, on the content inside its cards: the account avatar on
 * the first row's avatar or mark, the last action on the rows' ends
 * ([assertOnRowContent]). Glyphs are centred in
 * their controls, so a glyph's edge is its control's centre less half its
 * size. With HAPPY_SHOTS_DIR set, each screen is also written there as
 * `foldable-<screen>-<width>.png`.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
abstract class FoldableLayoutTest(
    private val width: Int,
    /** The keyline the tokens give at [width], from the window's edge. */
    private val keyline: Dp,
) {
    @get:Rule val rule = createComposeRule()

    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)
    private val window = width.dp
    private val tokens = ContentTokens.of(WidthClass.of(window))

    private fun show(content: @Composable () -> Unit) {
        rule.setHappyContent { ProvideWindowLayout(Modifier.fillMaxSize()) { content() } }
        rule.waitForIdle()
    }

    private fun shot(name: String) {
        val dir = dir ?: return
        dir.mkdirs()
        rule.mainClock.advanceTimeBy(1_000)
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "foldable-$name-$width.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun first(tag: String): DpRect = rule.onAllNodesWithTag(tag, useUnmergedTree = true)[0].getUnclippedBoundsInRoot()

    /** The visible glyph, [size] square, centred in the control [tag]. */
    private fun glyph(tag: String, size: Dp): DpRect {
        val control = rule.node(tag).bounds
        val cx = (control.left + control.right) / 2
        val cy = (control.top + control.bottom) / 2
        return DpRect(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2)
    }

    private fun assertOnKeylines(what: String, leading: DpRect?, trailing: DpRect?, content: DpRect) {
        assertDp("$what: content starts on the keyline", keyline, content.left)
        assertDp("$what: content ends on the keyline", window - keyline, content.right)
        if (leading != null) assertDp("$what: the leading glyph's edge is the content's", content.left, leading.left)
        if (trailing != null) assertDp("$what: the trailing glyph's edge is the content's", content.right, trailing.right)
    }

    /**
     * Home's bar over its cards: the account avatar's left edge is the first
     * row's avatar or mark ([rowStart]), and the last action's glyph's right
     * edge is where the rows' content ends ([rowEnd]), both a card's inset
     * inside the keyline.
     */
    private fun assertOnRowContent(what: String, avatar: DpRect, trailing: DpRect, rowStart: Dp, rowEnd: Dp) {
        assertDp("$what: rows start a card's inset inside the keyline", keyline + HomeCardSpec.inset, rowStart)
        assertDp("$what: rows end a card's inset inside the keyline", window - keyline - HomeCardSpec.inset, rowEnd)
        assertDp("$what: the account avatar's left is the first row's avatar's", rowStart, avatar.left)
        assertDp("$what: the last action's glyph ends where the rows' content does", rowEnd, trailing.right)
    }

    /**
     * At rest, at the top of its list, nothing of the content lies in the
     * bar's feather ([GlassSpec.feather], under the bar's foot): the first
     * row is wholly below it, and only what scrolls up goes soft. [held] is
     * for a screen whose content is held below the bar instead and so has no
     * feather: its content stays below the bar's foot, as before.
     */
    private fun assertRestsBelowFeather(what: String, held: Boolean = false) {
        val bar = rule.node(GlassBarTags.BAR).fetchSemanticsNode()
        val inBar = HashSet<Int>()
        fun walk(node: SemanticsNode) {
            inBar += node.id
            node.children.forEach(::walk)
        }
        walk(bar)
        val visible = SemanticsMatcher("shows something") {
            SemanticsProperties.Text in it.config || SemanticsProperties.ContentDescription in it.config || SemanticsProperties.TestTag in it.config
        }
        val density = rule.density.density
        val window = rule.onRoot().fetchSemanticsNode().boundsInRoot
        val content = rule.onAllNodes(visible.or(hasClickAction()), useUnmergedTree = true).fetchSemanticsNodes()
            .filter { it.id !in inBar && it.boundsInRoot.height > 0f && it.boundsInRoot.height < window.height / 2 }
        val top = content.minOf { it.boundsInRoot.top } / density
        val foot = bar.boundsInRoot.bottom / density
        if (held) {
            assertTrue("$what: the content (at $top) is held below the bar's foot ($foot)", top >= foot - 0.34f)
        } else {
            val first = content.minBy { it.boundsInRoot.top }
            assertTrue(
                "$what: the first row (${first.config}) starts at $top, inside the feather ($foot to ${foot + GlassSpec.feather.value})",
                top >= foot + GlassSpec.feather.value - 0.34f,
            )
        }
    }

    /** A reversed transcript scrolled back to its oldest row, at rest. */
    private fun scrollToOldest(list: String) {
        // From the middle, not the list's top edge, which is under the bar.
        repeat(8) { rule.node(list).performTouchInput { swipeDown(startY = centerY, endY = bottom) } }
        rule.mainClock.advanceTimeBy(2_000)
        rule.waitForIdle()
    }

    @Test
    fun theTokensGiveThisKeyline() {
        assertDp("keyline", keyline, tokens.keyline(window))
        assertDp("the column", window - (keyline - ContentTokens.inset) * 2, tokens.columnWidth(window))
        val measure = window - keyline * 2
        assertEquals("never past the readable measure", true, measure <= tokens.maxContentWidth)
        assertEquals("never nearer the glass than the margin", true, keyline >= tokens.margin)
    }

    @Test
    fun agentHome() {
        show {
            AgentHomeScreen(
                "Studio",
                AgentFeed.derive(AgentHomeLayoutTest.catalog(AgentHomeLayoutTest.sample)),
                AgentLinkStatus.Connected,
                AccountMenu(listOf(AccountMenuEntry("agent-connection-1", "Studio", agent = true, active = true))),
                AgentHomeActions({}, {}, {}, {}, {}, {}),
            )
        }
        val row = rule.node(AgentHomeTags.row("agent-ab1")).bounds
        val card = DpRect(row.left + ContentTokens.inset, row.top, row.right - ContentTokens.inset, row.bottom)
        assertOnKeylines("agent home", null, null, card)
        // The bar's outer glyphs stand on the content inside the cards: the first row's mark, the dots at the rows' ends.
        val mark = first(AgentHomeTags.ROW_MARK)
        val dot = first(AgentHomeTags.ROW_DOT)
        assertOnRowContent("agent home", glyph(AccountMenuTags.BUTTON, 32.dp), glyph(AgentHomeTags.SETTINGS, 24.dp), mark.left, dot.right)
        assertDp("agent home: search sits 48 before settings", glyph(AgentHomeTags.SETTINGS, 24.dp).right - 48.dp, glyph(AgentHomeTags.SEARCH, 24.dp).right)
        assertRestsBelowFeather("agent home")
        shot("agent-home")
    }

    @Test
    fun legacyHome() {
        val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
        fun titled(path: String, title: String) = metadata(path = path) {
            put("machineId", "m1")
            putJsonObject("summary") { put("text", title); put("updatedAt", 1) }
        }
        val state = deriveHomeList(
            HomeListInputs(
                HomeSnapshot(
                    listOf(
                        session("a", titled("/Users/dev/happy", "Port the legacy home to cards"), thinking = true, lastMessageSentAt = noon),
                        session("b", titled("/Users/dev/site", "Fix the pricing page"), lastMessageSentAt = noon - 60_000),
                        session("c", titled("/Users/dev/happy", "Release notes for 1.4"), lastMessageSentAt = noon - 86_400_000),
                    ),
                    listOf(machine("m1", machineMetadata { put("displayName", "Studio") })),
                ),
                SessionListGrouping.Flat, false, emptySet(), emptySet(), emptySet(),
            ),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        show {
            HomeScreen(
                state, ConnectionStatus.CONNECTED, state.grouping,
                HomeListCallbacks({}, {}, {}, {}, {}, {}, {}, { _, _ -> }),
                HomeScreenActions(onSettings = {}, onNewSession = {}, onTroubleshoot = {}, onOpenUrl = {}, onWhatsNew = {}, onLinkComputer = {}),
                accounts = AccountMenu(listOf(AccountMenuEntry("acc", "Steve", active = true))),
            )
        }
        val row = first(HomeTags.CARD_ROW)
        val card = DpRect(row.left + ContentTokens.inset, row.top, row.right - ContentTokens.inset, row.bottom)
        assertOnKeylines("legacy home", null, null, card)
        // The first row's avatar, and the slot at its end where its dot stands.
        val avatar = first(FlatRowTags.AVATAR)
        val end = first(FlatRowTags.TOP_RIGHT)
        assertOnRowContent("legacy home", glyph(AccountMenuTags.BUTTON, 32.dp), glyph(HomeTags.SETTINGS, 24.dp), avatar.left, end.right)
        assertRestsBelowFeather("legacy home")
        shot("legacy-home")
    }

    @Test
    fun agentChat() {
        val rows = (0 until 6).flatMap { i ->
          listOf(
            Message("u$i", "user", 2L * i + 1, listOf(Block.Text("The login page loops back to itself after sign-in. Can you find out why?"))),
            Message(
                "a$i", "agent", 2L * i + 2,
                listOf(
                    Block.ToolCall("c1", "Bash", "completed", Presentation.Command("grep -rn redirect sources/auth", "...")),
                    Block.Text(
                        "Found it: the callback rewrites the URL **before** the cookie is written, so the guard sends the " +
                            "reader back to `/login`. Moving the redirect after `setSession` fixes the loop.",
                    ),
                ),
            ),
          )
        }.flatMap { ConversationRowBuilder.build(it, "a1", null, false) }.asReversed()
        val state = ConversationState(
            created = true, loaded = true, rows = rows,
            agent = AgentInfo("a1", "w1", null, "Fix the login redirect", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2),
            mode = Mode("claude", "anthropic/opus-5", "high", null, "auto"),
        )
        show { ConversationScreen(state, null, ConversationScreenActions()) }
        val text = first(MessageTags.AGENT)
        assertOnKeylines("agent chat", glyph(ConversationScreenTags.BACK, 24.dp), glyph(ConversationScreenTags.COMPOSE, 24.dp), text)
        // The composer is the column's, 12 in, as on a phone.
        val composer = rule.node(ConversationComposerTags.COMPOSER).bounds
        assertDp("the composer is the column", window - (keyline - ContentTokens.inset) * 2, composer.width)
        assertDp("and centred", keyline - ContentTokens.inset, composer.left)
        shot("agent-chat")
        scrollToOldest(ConversationScreenTags.LIST)
        assertRestsBelowFeather("agent chat")
    }

    @Test
    fun legacyChat() {
        val session = ChatSessionInfo.from(
            SessionRecord(
                "s", 0, 0, 1, true, 0,
                """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux","summary":{"text":"Fix the login redirect","updatedAt":1}}""",
                1, null, 1, "", null,
            ),
        )
        val transcript = (0 until 8).flatMap { i ->
            listOf(
                ChatReduction.buildRow(
                    ChatMessage.AgentText(
                        "a$i", 2L * i + 1,
                        "Step ${i + 1}: the redirect reads the **session cookie** before the auth callback has written it, so the guard sends the reader back to `/login`.",
                    ),
                    true,
                )!!,
                ChatReduction.buildRow(ChatMessage.UserText("u$i", "l$i", 2L * i, "What happens at step ${i + 1}?"), false)!!,
            )
        }.asReversed()
        show {
            ChatScreen(
                state = ChatState(ChatSnapshot(transcript, loaded = true), session, sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
            )
        }
        val text = first(MessageTags.AGENT)
        assertOnKeylines("legacy chat", glyph(HeaderTags.LEFT, 24.dp), glyph(ChatScreenTags.COMPOSE, 24.dp), text)
        // The composer's panel is the column's, 8 in, as on a phone.
        val panel = rule.node(ComposerTags.PANEL).bounds
        assertDp("the composer starts 8 inside the column", keyline - ContentTokens.inset + 8.dp, panel.left)
        assertDp("and ends 8 inside it", window - keyline + ContentTokens.inset - 8.dp, panel.right)
        shot("legacy-chat")
        scrollToOldest(ChatListTags.LIST)
        assertRestsBelowFeather("legacy chat")
    }

    @Test
    fun artifacts() {
        val day = 86_400_000L
        val now = System.currentTimeMillis()
        val items = listOf(
            ArtifactSummary("a1", "markdown", "Release notes", 3, null, createdAt = now, updatedAt = now),
            ArtifactSummary("a2", "html", "Dashboard", 1, null, createdAt = now - day, updatedAt = now - day),
            ArtifactSummary("a3", "image", "Screenshots of the new onboarding flow on every size of phone", 2, null, createdAt = now - 3 * day, updatedAt = now - 3 * day),
        )
        show { ArtifactsScreen(ArtifactCatalogFeed.State(items, loaded = true), {}, {}, {}) }
        // The cards stand on the column's keyline; the title is a card's 16, a tile and its 12 further in.
        val row = first(ArtifactsTags.ROW)
        val card = DpRect(row.left + ContentTokens.inset, row.top, row.right - ContentTokens.inset, row.bottom)
        assertOnKeylines("artifacts", glyph(ConversationScreenTags.BACK, 24.dp), null, card)
        assertRestsBelowFeather("artifacts", held = true)
        shot("artifacts")
    }

    @Test
    fun surface() {
        show {
            SurfaceScreen("Groceries", PlaceRead.Ready(SurfaceBody.Todos(listOf(Todo("t1", "Eggs", false), Todo("t2", "Milk", true)))), {}, {}, {})
        }
        assertOnKeylines("surface", glyph(ConversationScreenTags.BACK, 24.dp), null, first(AgentPlacesTags.TODO))
        assertRestsBelowFeather("surface", held = true)
        shot("surface")
    }

    @Test
    fun settings() {
        show {
            SettingsScreen(
                profile = SettingsFixtures.profile,
                about = AboutInfo("1.8.0 (412)", "Commit 2026-10-16 03:12 UTC / abc1234"),
                accounts = SettingsFixtures.accounts,
            )
        }
        val card = first(ItemGroupTags.CARD)
        assertOnKeylines("settings", glyph(HeaderTags.LEFT, 24.dp), null, card)
        assertRestsBelowFeather("settings")
        shot("settings")
    }

    @Test
    fun agentPage() {
        show { AgentPageScreen(AgentPageFixtures.page, AgentPageActions(), now = AgentPageFixtures.NOW) }
        assertOnKeylines("agent page", glyph(HeaderTags.LEFT, 24.dp), null, first(AgentPageTags.TILES))
        assertOnKeylines("agent page's family", null, null, first(AgentPageTags.FAMILY))
        val mark = first(AgentPageTags.MARK)
        assertDp("agent page: the mark is centred on the window", window / 2, (mark.left + mark.right) / 2)
        assertRestsBelowFeather("agent page")
        shot("agent-page")
    }
}

/** A phone upright: compact, exactly as before, the 16 keyline. */
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class FoldableLayoutPhoneTest : FoldableLayoutTest(411, 16.dp)

/** A Galaxy Z Fold7's inner screen upright (1968 px at 420 dpi): medium, a 640 measure centred, 55 in. */
@Config(qualifiers = "w750dp-h832dp-xxhdpi")
class FoldableLayoutFoldTest : FoldableLayoutTest(750, 55.dp)

/** The same Fold on its side (832): still medium, under the 840 shell, so one pane, 96 in. */
@Config(qualifiers = "w832dp-h750dp-xxhdpi")
class FoldableLayoutFoldSidewaysTest : FoldableLayoutTest(832, 96.dp)

/** A tablet on its side: expanded, the 800 column centred, 256 in. */
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
class FoldableLayoutTabletTest : FoldableLayoutTest(1280, 256.dp)
