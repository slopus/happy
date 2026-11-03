package com.slopus.happy.ui.connection

import androidx.activity.ComponentActivity
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.click
import androidx.compose.ui.test.filter
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.conversation.ConversationRowActions
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A held home row's conversation in Telegram's preview card (iOS bf177c134, HoldLayout, PreviewLayout). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatPreviewTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val opened = mutableListOf<String>()
    private val previewed = mutableListOf<String>()
    private val actions = AgentHomeActions(
        onOpenConversation = { opened += it },
        onCompose = {},
        onSettings = {},
        onSettingsRow = {},
        onSwitchAccount = {},
        onAdd = {},
    )

    private fun show(dark: Boolean = false, preview: Boolean = true) = rule.setHappyContent(dark) {
        AgentHomeScreen(
            "Studio",
            AgentFeed.derive(AgentHomeLayoutTest.catalog(AgentHomeLayoutTest.sample)),
            AgentLinkStatus.Connected,
            AccountMenu(),
            actions,
            preview = if (preview) { row -> previewed += row.agentId; Box(Modifier.fillMaxSize().testTag(INSIDE)) } else null,
        )
    }

    private fun hold(agentId: String) {
        rule.node(AgentHomeTags.row("agent-$agentId")).performTouchInput { longClick() }
        rule.waitForIdle()
    }

    @Test
    fun aHeldRowShowsItsChatInTheCardAndATapOnItOpensTheChat() {
        show()
        hold("at2")
        assertEquals(listOf("at2"), previewed.distinct())
        // The screen less 12 a side, 460 tall, centred on the 891 high window.
        assertBox("card", rule.node(ChatPreviewTags.CARD).bounds, 12.dp, ((891 - 460) / 2f).dp, 387.dp, 460.dp)
        assertBox("inside", rule.node(INSIDE).bounds, 12.dp, ((891 - 460) / 2f).dp, 387.dp, 460.dp)
        rule.node(ChatPreviewTags.CARD).performClick()
        rule.waitForIdle()
        assertEquals(listOf("at2"), opened)
        rule.onAllNodesWithTag(ChatPreviewTags.CARD).assertCountEquals(0)
    }

    @Test
    fun aTapBesideTheCardOrBackPutsItAwayWithoutOpening() {
        show(dark = true)
        hold("ab1")
        rule.node(ChatPreviewTags.SCRIM).performTouchInput { click(Offset(20f, 20f)) }
        rule.waitForIdle()
        rule.onAllNodesWithTag(ChatPreviewTags.CARD).assertCountEquals(0)
        hold("ab1")
        rule.node(ChatPreviewTags.CARD).assertExists()
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.onAllNodesWithTag(ChatPreviewTags.CARD).assertCountEquals(0)
        assertTrue(opened.isEmpty())
        // TalkBack: the dim is named, so it can be put away.
        hold("ab1")
        rule.node(ChatPreviewTags.SCRIM).assert(hasContentDescription("Close"))
    }

    @Test
    fun withNoPreviewAHoldShowsNothing() {
        show(preview = false)
        hold("at2")
        rule.onAllNodesWithTag(ChatPreviewTags.SCRIM).assertCountEquals(0)
        // A press held long is a tap, as before.
        assertEquals(listOf("at2"), opened)
    }

    @Test
    fun theCardGrowsOnTelegramsSpringAndGoesBackInPointTwoSeconds() {
        fun at(spec: androidx.compose.animation.core.AnimationSpec<Float>, from: Float, to: Float, ms: Long) =
            TargetBasedAnimation(spec, Float.VectorConverter, from, to).getValueFromNanos(ms * 1_000_000)
        // Mass 5, stiffness 900, damping 104: a damping ratio of 0.775 at 180/s², as Telegram's context spring.
        assertEquals(0.775f, com.slopus.happy.ui.chat.MessageLiftSpec.dampingRatio, 0.001f)
        assertEquals(180f, com.slopus.happy.ui.chat.MessageLiftSpec.stiffness, 0.001f)
        val grow = (0..1000 step 50).map { at(ChatPreviewSpec.grow, 0f, 1f, it.toLong()) }
        assertTrue("two thirds of the way by 0.15 s: ${grow[3]}", grow[3] > 0.65f)
        assertTrue("a slight overshoot, as Telegram's: ${grow.max()}", grow.max() in 1.0f..1.05f)
        assertEquals("settled by 0.6 s", 1f, grow[12], 0.01f)
        // Back over 0.2 s, ease in and out: half way at 0.1 s, done at 0.2 s.
        assertEquals(0.5f, at(ChatPreviewSpec.shrink, 1f, 0f, 100), 0.02f)
        assertEquals(0f, at(ChatPreviewSpec.shrink, 1f, 0f, 200), 0.001f)
    }

    @Test
    fun theCardFitsTheWindowAsHoldLayoutPlacesIt() {
        val px = { dp: Dp -> dp.value }
        // A wide window: at most 400.
        val wide = ChatPreviewSpec.card(Size(1000f, 800f), top = 24f, bottom = 48f, regular = true, px = px)
        assertEquals(400f, wide.width, 0.01f)
        assertEquals(300f, wide.left, 0.01f)
        assertEquals(460f, wide.height, 0.01f)
        // A short one: the room HoldLayout leaves between 8 under the status bar and 10 (and its 10) over the navigation bar.
        val short = ChatPreviewSpec.card(Size(400f, 420f), top = 24f, bottom = 48f, regular = false, px = px)
        assertEquals(androidx.compose.ui.geometry.Rect(12f, 32f, 388f, 352f), short)
    }

    @Test
    fun theTranscriptWearsItsNameInACapsuleAndSpinsUntilRead() {
        rule.setHappyContent {
            val colors = com.slopus.happy.ui.theme.HappyTheme.colors
            Box(Modifier.size(387.dp, 460.dp)) {
                ChatPreviewTranscript(
                    "Write release notes",
                    ConversationState(),
                    userMessageBubblePalette(null, colors.dark),
                    ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, loadMedia = { ByteArray(0) }),
                )
            }
        }
        val pill = rule.node(ChatPreviewTags.TITLE).bounds
        assertDp("capsule top", 10, pill.top)
        assertDp("capsule height", 44, pill.height)
        assertDp("centred", (387.dp - pill.width) / 2, pill.left)
        assertTrue("the name and 16 a side", pill.width > 32.dp)
        rule.onNodeWithText("Write release notes").assertExists()
        rule.onAllNodesWithTag(ChatPreviewTags.TITLE).filter(isHeading()).assertCountEquals(1)
        rule.node(ChatPreviewTags.LOADING).assertExists()
    }

    private companion object {
        const val INSIDE = "chatPreview.test.inside"
    }
}
