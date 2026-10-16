package com.slopus.happy.ui.tablet

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.tools.PermissionChoice
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.collectMachineChoices
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatComposer
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerStatus
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.chat.MessageView
import com.slopus.happy.ui.chat.PermissionFooter
import com.slopus.happy.ui.chat.PermissionTags
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val TABLET = "w1280dp-h800dp-xhdpi"
private const val TABLET_WIDTH = 1280

/** layout.ts on a 10-inch tablet: 800 of content, centred; and the useIsTablet branches inside screens. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = TABLET)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @Composable () -> Unit) = rule.setHappyContent { ProvideWindowLayout { content() } }

    private val centredLeft = ((TABLET_WIDTH - 800) / 2).dp

    // MessageView.tsx: each message held to 800, centred; the user bubble still ends 16 in from its column.
    @Test
    fun messagesAreHeldTo800() {
        val row = ChatReduction.buildRow(ChatMessage.UserText("u", "l", 0, "Hello"), isClaudeFlavor = false) as ChatRow.User
        show { MessageView(row, userMessageBubblePalette("gray", dark = false), MessageCallbacks()) }
        val user = rule.node(MessageTags.USER).bounds
        assertBox("message column", user, centredLeft, user.top, 800.dp, user.bottom - user.top)
        assertDp("bubble ends 16 in", centredLeft + 800.dp - 16.dp, rule.node(MessageTags.USER_BUBBLE).bounds.right)
    }

    // AgentInput.tsx `innerContainer`: inside the 8 padding, held to 800 and centred.
    @Test
    fun composerIsHeldTo800() {
        show {
            ChatComposer(
                text = "",
                onTextChange = {},
                status = ComposerStatus("online", SessionStatusColors.online, pulsing = false),
                primary = PrimaryAction.Idle,
                onPrimary = {},
            )
        }
        val panel = rule.node(ComposerTags.PANEL).bounds
        assertBox("panel", panel, centredLeft, panel.top, 800.dp, panel.bottom - panel.top)
        assertDp("composer still spans the window", TABLET_WIDTH, rule.node(ComposerTags.COMPOSER).bounds.right)
    }

    // ItemGroup.tsx: the 800 container holds the 4 padding; the card is 12 further in.
    @Test
    fun itemGroupsAreHeldTo800() {
        show { Column { ItemGroup(title = "Group") { Item(title = "Account", onClick = {}) } } }
        val card = rule.node(ItemGroupTags.CARD).bounds
        assertBox("card", card, centredLeft + 16.dp, card.top, (800 - 32).dp, card.bottom - card.top)
    }

    // PermissionFooter.tsx: a tablet hugs each button to its label at the trailing edge.
    @Test
    fun permissionButtonsHugTheTrailingEdge() {
        show {
            PermissionFooter(
                permission = ToolPermission("p", PermissionStatus.Pending),
                toolName = "Bash",
                toolInput = null,
                flavor = "claude",
                onAnswer = { _, _ -> },
            )
        }
        val footer = rule.node(PermissionTags.FOOTER).bounds
        val allow = rule.node(PermissionTags.option(PermissionChoice.Allow)).bounds
        assertDp("ends 6 in", footer.right - 6.dp, allow.right)
        assertTrue("hugs its label", allow.right - allow.left < 300.dp)
    }

    // SessionView.tsx / ChatHeaderView.tsx: no avatar on a tablet, the bar held to 800, centred.
    @Test
    fun chatHeaderOnATablet() {
        val info = ChatSessionInfo.from(
            SessionRecord(
                "s", 0, 0, 1, true, 0,
                """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux","summary":{"text":"Fix the login","updatedAt":1}}""",
                1, null, 1, "", null,
            ),
        )
        show { ChatScreen(ChatState(ChatSnapshot(emptyList(), loaded = true), info, sessionLoaded = true, online = true), draft = "", bubbleColor = "gray", actions = ChatScreenActions()) }
        rule.onAllNodesWithTag(ChatScreenTags.AVATAR, useUnmergedTree = true).assertCountEquals(0)
        val bar = rule.node(HeaderTags.BAR).bounds
        assertBox("bar", bar, centredLeft, bar.top, 800.dp, 64.dp)
    }

    @Test
    fun emptySessionsStates() {
        val studio = machine("m1", machineMetadata { put("displayName", "Studio") })
        show { EmptySessionsTablet(collectMachineChoices(listOf(studio)), onNewSession = {}, onTroubleshoot = {}) }
        rule.node(EmptySessionsTabletTags.BUTTON).assertExists()
        val icon = rule.node(EmptySessionsTabletTags.ICON).bounds
        val title = rule.node(EmptySessionsTabletTags.TITLE).bounds
        assertDp("64 glyph", 64, icon.bottom - icon.top)
        assertDp("title 24 under the glyph", icon.bottom + 24.dp, title.top)
        val description = rule.node(EmptySessionsTabletTags.DESCRIPTION).bounds
        assertDp("description 8 under the title", title.bottom + 8.dp, description.top)
        assertDp("button 24 under the description", description.bottom + 24.dp, rule.node(EmptySessionsTabletTags.BUTTON).bounds.top)
    }

    // On a phone the same measured window changes nothing.
    @Test
    @Config(qualifiers = PHONE)
    fun phoneContentIsUnheld() {
        show {
            ChatComposer(
                text = "",
                onTextChange = {},
                status = null,
                primary = PrimaryAction.Idle,
                onPrimary = {},
            )
        }
        assertBox("panel", rule.node(ComposerTags.PANEL).bounds, 8.dp, rule.node(ComposerTags.PANEL).bounds.top, (PHONE_WIDTH - 16).dp, rule.node(ComposerTags.PANEL).bounds.let { it.bottom - it.top })
    }
}
