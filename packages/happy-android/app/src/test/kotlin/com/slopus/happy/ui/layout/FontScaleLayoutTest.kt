package com.slopus.happy.ui.layout

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatComposer
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ComposerStatus
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.chat.UserMessage
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeListInputs
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.home.HomeSnapshot
import com.slopus.happy.ui.home.deriveHomeList
import com.slopus.happy.ui.node
import com.slopus.happy.ui.onboarding.OnboardingContentTags
import com.slopus.happy.ui.onboarding.WelcomeScreen
import com.slopus.happy.ui.settings.SettingsScreen
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate
import java.time.ZoneOffset

/** The largest system font size Android offers, with the platform's sp curve (non-linear from Android 14). */
private val LARGE_TEXT = Density(3f, fontScale = 2f)

/** An sp size at [LARGE_TEXT]; Compose and RN 0.83 (`TypedValue.applyDimension`) agree on font sizes. */
private fun large(sp: Int): Dp = with(LARGE_TEXT) { sp.sp.toDp() }

/**
 * A [fontSize]/[lineHeight] line at [LARGE_TEXT]. Under non-linear scaling
 * Compose keeps the line's ratio to the font; RN converts the line height on
 * its own curve, so its lines run a few dp shorter (22 over 17: 35 against 37.7).
 */
private fun line(fontSize: Int, lineHeight: Int): Dp = large(fontSize) * lineHeight.toFloat() / fontSize.toFloat()

/**
 * RN on Android scales every Text by the system font scale, uncapped, except
 * the onboarding titles (maxFontSizeMultiplier 1.2). Icons, paddings and
 * avatars stay put. At 2.0 every line grows along the sp curve, rows that hold text grow
 * rather than clip, and no text node is laid out shorter than its lines.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FontScaleLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val homeCallbacks = HomeListCallbacks({}, {}, {}, {}, {}, {}, {}, { _, _ -> })
    private val homeActions = HomeScreenActions({}, {}, {}, {}, {}, {}, {})

    private fun showLarge(content: @Composable () -> Unit) {
        rule.setHappyContent { CompositionLocalProvider(LocalDensity provides LARGE_TEXT, content = content) }
    }

    /** Every text node whose box is shorter than its laid-out lines, so its last lines are cut. */
    private fun assertNothingClipped() {
        val clipped = mutableListOf<String>()
        fun visit(node: SemanticsNode) {
            node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.let { action ->
                val results = mutableListOf<TextLayoutResult>()
                action.action?.invoke(results)
                val layout = results.firstOrNull()
                if (layout != null && layout.size.height + 1 < layout.multiParagraph.height) {
                    val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString().orEmpty()
                    clipped += "'$text': ${layout.size.height}px box, ${layout.multiParagraph.height}px of text"
                }
            }
            node.children.forEach(::visit)
        }
        rule.onAllNodes(isRoot(), useUnmergedTree = true).fetchSemanticsNodes().forEach(::visit)
        assertTrue("clipped text:\n" + clipped.joinToString("\n"), clipped.isEmpty())
    }

    private val DpRect.height get() = bottom - top
    private fun assertInside(name: String, outer: DpRect, inner: DpRect) {
        assertTrue("$name top ${inner.top} inside ${outer.top}", inner.top >= outer.top - 0.34.dp)
        assertTrue("$name bottom ${inner.bottom} inside ${outer.bottom}", inner.bottom <= outer.bottom + 0.34.dp)
    }

    // FlatSessionRow at 2.0: title and project lines grow; the avatar and the text's 88 inset don't move.
    @Test
    fun homeRowGrows() {
        val studio = machine("m1", machineMetadata { put("displayName", "Studio") })
        val sessions = listOf(session("a", metadata = metadata(path = "/Users/dev/a") { put("machineId", "m1") }, active = true, lastMessageSentAt = noon))
        val state = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, listOf(studio)), SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        showLarge { HomeScreen(state, ConnectionStatus.DISCONNECTED, SessionListGrouping.Flat, homeCallbacks, homeActions) }
        assertNothingClipped()
        val row = rule.node(FlatRowTags.ROW).bounds
        val title = rule.node(FlatRowTags.TITLE).bounds
        val project = rule.node(FlatRowTags.PROJECT).bounds
        assertDp("title line", line(17, 22), title.height)
        assertDp("project line", line(15, 20), project.height)
        assertTrue("title grows past 22", title.height > 30.dp)
        assertDp("title still 88 in", 88, title.left)
        assertDp("title still 10 down", row.top + 10.dp, title.top)
        assertDp("avatar stays 60", 60, rule.node(FlatRowTags.AVATAR).bounds.height)
        assertTrue("row grows past 81", row.height > 81.dp)
        assertInside("project", row, project)
        val corner = rule.node(FlatRowTags.TOP_RIGHT).bounds
        val stamp = rule.node(FlatRowTags.TIMESTAMP).bounds
        assertDp("timestamp line", line(13, 22), stamp.height)
        assertDp("the corner slot stays 22", 22, corner.height)
        assertDp("timestamp overflows it, centred", (corner.top + corner.bottom) / 2, (stamp.top + stamp.bottom) / 2)
        assertInside("timestamp", row, stamp)
    }

    @Test
    fun projectListFitsLargeText() {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        val sessions = listOf(
            session("own", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
            session("wt", metadata = rigMetadata(projectId = "p1", projectName = "happy", workspaceId = "w1", workspaceName = "Gdansk"), lastMessageSentAt = noon),
        )
        val state = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, listOf(rig)), SessionListGrouping.Project, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        showLarge { HomeScreen(state, ConnectionStatus.CONNECTED, SessionListGrouping.Project, homeCallbacks, homeActions) }
        assertNothingClipped()
    }

    // MessageView at 2.0: the 25 text line and the 14 status line grow inside the same 12/4 + 8/10 padding.
    @Test
    fun userMessageGrows() {
        val row = ChatReduction.buildRow(ChatMessage.UserText("u", "l", 0, "Hello"), isClaudeFlavor = false) as ChatRow.User
        showLarge { UserMessage(row, userMessageBubblePalette("gray", dark = false), MessageCallbacks()) }
        assertNothingClipped()
        val bubble = rule.node(MessageTags.USER_BUBBLE).bounds
        val text = rule.node(MarkdownTags.TEXT).bounds
        assertDp("text line", line(16, 25), text.height)
        assertTrue("text grows past 25", text.height > 35.dp)
        assertDp("text still 12 in", 12, text.left - bubble.left)
        assertDp("bubble padding unchanged", 4.dp + 8.dp + line(16, 25) + 10.dp + 4.dp, bubble.height)
        val status = rule.node(MessageTags.USER_STATUS).bounds
        assertDp("status line", line(11, 14), status.height)
        assertInside("status", rule.node(MessageTags.USER).bounds, status)
    }

    @Test
    fun chatScreenAndComposerFitLargeText() {
        val info = ChatSessionInfo.from(
            SessionRecord(
                "s", 0, 0, 1, true, 0,
                """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux","summary":{"text":"Fix the login","updatedAt":1}}""",
                1, null, 1, "", null,
            ),
        )
        val rows = listOf(
            ChatReduction.buildRow(ChatMessage.AgentText("a", 2, "Reply"), true)!!,
            ChatReduction.buildRow(ChatMessage.UserText("u", "l", 0, "Question"), false)!!,
        )
        showLarge {
            ChatScreen(
                state = ChatState(ChatSnapshot(rows, loaded = true), info, sessionLoaded = true, online = true),
                draft = "",
                bubbleColor = "gray",
                actions = ChatScreenActions(),
            )
        }
        assertNothingClipped()
    }

    @Test
    fun composerFitsLargeText() {
        showLarge {
            ChatComposer(
                text = "",
                onTextChange = {},
                status = ComposerStatus("online", SessionStatusColors.online, pulsing = false),
                primary = PrimaryAction.Idle,
                onPrimary = {},
            )
        }
        assertNothingClipped()
    }

    // Item at 2.0: the 24 title line grows and the row with it; the chevron and padding don't scale.
    @Test
    fun settingsItemGrows() {
        showLarge { Box(Modifier.fillMaxWidth()) { Item(title = "Account", onClick = {}) } }
        assertNothingClipped()
        val title = rule.node(ItemTags.TITLE).bounds
        assertDp("title line", line(16, 24), title.height)
        assertTrue("title grows past 24", title.height > 35.dp)
        assertDp("title still 16 in", 16, title.left)
        val row = rule.node(ItemTags.ROW).bounds
        assertBox("row", row, 0.dp, 0.dp, PHONE_WIDTH.dp, 16.dp + line(16, 24) + 16.dp)
        assertBox("chevron stays 24", rule.node(ItemTags.CHEVRON).bounds, (PHONE_WIDTH - 16 - 24).dp, (row.height - 24.dp) / 2, 24.dp, 24.dp)
    }

    @Test
    fun settingsScreenFitsLargeText() {
        showLarge { SettingsScreen(versionName = "0.1.0", onBack = {}, onAccount = {}, onAppearance = {}, onOpenUrl = {}) }
        assertNothingClipped()
    }

    // The header bar stays 64, as in RN; a title and subtitle taller than it overflow it, centred.
    @Test
    fun headerKeepsItsHeight() {
        showLarge { Header(title = "Fix the login", subtitle = "online", left = {}) }
        assertNothingClipped()
        val bar = rule.node(HeaderTags.BAR).bounds
        val title = rule.node(HeaderTags.TITLE).bounds
        val subtitle = rule.node(HeaderTags.SUBTITLE).bounds
        assertDp("bar stays 64", 64, bar.height)
        assertDp("title line", line(16, 20), title.height)
        assertDp("subtitle line", line(12, 16), subtitle.height)
        assertTrue("title and subtitle outgrow the bar", subtitle.bottom - title.top > 64.dp)
        assertDp("block centred on the bar", (bar.top + bar.bottom) / 2, (title.top + subtitle.bottom) / 2)
    }

    // react-native-vector-icons render with allowFontScaling false: a 32 glyph is 32 at any scale.
    @Test
    fun iconsKeepTheirSize() {
        showLarge { Icon(Ionicon.PersonCircleOutline, 32.dp, Color.Black) }
        val glyph = rule.onNodeWithText(String(Character.toChars(Ionicon.PersonCircleOutline.codepoint)), useUnmergedTree = true)
        val results = mutableListOf<TextLayoutResult>()
        glyph.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
        assertEquals("one 32 line at density 3", 96, results.single().size.height)
    }

    // OnboardingContent.tsx: titles capped at 1.2, so a 34 line is never more than 40.8 (RN: min(scaled, 1.2x)).
    @Test
    fun onboardingTitlesAreCapped() {
        showLarge {
            Box(Modifier.fillMaxSize()) {
                WelcomeScreen(customServerLabel = null, creatingAccount = false, onCreateAccount = {}, onRestore = {}, onServer = {})
            }
        }
        assertNothingClipped()
        val headline = rule.onNodeWithTag(OnboardingContentTags.HEADLINE).bounds
        assertTrue("the cap bites at 2.0", line(28, 34) > 40.8.dp)
        val lines = headline.height / 40.8.dp
        assertEquals("headline is whole 40.8 lines", Math.round(lines).toFloat(), lines, 0.02f)
    }
}
