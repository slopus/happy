package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.NewWork
import com.slopus.happy.conversation.SlashCommand
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.autocomplete.AutocompleteTags
import com.slopus.happy.ui.bounds
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
 * Mentioning a teammate from the conversation's composer (desktop's
 * mention list). Spec: an `@` word at the cursor lists the team whose names
 * hold it, the reader left out, each a 48 row: their face in a 32 circle 12
 * before the name, then their role; the list 8 above the composer pill, 8
 * in from its edges. A tap puts `[Name](happy://users/<id>)` and a space in
 * the draft in the word's place, shown in the field as "@Name"; that
 * Markdown is what goes. A delete into the mention takes it whole. A new
 * chat offers the same; without a team an `@` is text.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationMentionsTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Release notes", "idle", null, null, 1, 2, 0, 0)

    private val people = listOf(
        TeamUser("u_anna", "Anna Lee", role = "Billing engineer"),
        TeamUser("u_kirill", "Kirill"),
        TeamUser("u_max", "Max Anders"),
        TeamUser("u_steve", "Steve"),
    )

    private val rows = ConversationRowBuilder.build(Message("m1", "agent", 1, listOf(Block.Text("Ready when you are."))), "a1", null, false).asReversed()

    private val sent = ArrayList<String>()
    private val drafts = ArrayList<String>()

    private fun setScreen(
        dark: Boolean = false,
        state: ConversationState = ConversationState(created = true, loaded = true, rows = rows, agent = agent),
        team: List<TeamUser> = people,
    ) {
        rule.setHappyContent(dark) {
            ProvideWindowLayout {
                ConversationScreen(
                    state,
                    ConversationScreenActions(
                        onDraftChange = { drafts += it },
                        onSend = { words, _ -> sent += words; true },
                    ),
                    people = team,
                    self = "u_steve",
                )
            }
        }
    }

    private fun listRows() = rule.onAllNodesWithTag(AutocompleteTags.ROW, useUnmergedTree = true)

    private fun shown(): String =
        rule.node(ConversationComposerTags.INPUT).fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun anAtListsTheTeamWithoutTheReaderOverTheComposer() {
        setScreen()
        rule.node(ConversationComposerTags.INPUT).performTextInput("ask @")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 3 }
        rule.onNode(hasText("Steve"), useUnmergedTree = true).assertDoesNotExist()
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        val list = rule.node(AutocompleteTags.LIST).bounds
        assertBox("list", list, pill.left + 8.dp, pill.top - 8.dp - 144.dp, pill.right - pill.left - 16.dp, 144.dp)
        val first = listRows()[0].bounds
        assertDp("row height", first.bottom - first.top, 48.dp)
        val face = rule.onAllNodesWithTag(AutocompleteTags.ICON, useUnmergedTree = true)[0].bounds
        assertBox("face", face, first.left + 16.dp, first.top + 8.dp, 32.dp, 32.dp)
        rule.onNode(hasText("Billing engineer"), useUnmergedTree = true).assertExists()
        shot("mentions-light")
    }

    @Test
    fun theListInTheDark() {
        setScreen(dark = true)
        rule.node(ConversationComposerTags.INPUT).performTextInput("@")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 3 }
        shot("mentions-dark")
    }

    @Test
    fun typingFiltersByTheName() {
        setScreen()
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("@an")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 2 }
        rule.onNode(hasText("Kirill"), useUnmergedTree = true).assertDoesNotExist()
        input.performTextInput("na")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        input.performTextInput(" ")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun aTapWritesTheirMentionShownAsTheirNameAndSendGoesWithIt() {
        setScreen()
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("ask @ann")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        listRows()[0].performClick()
        rule.waitForIdle()
        assertEquals("ask [Anna Lee](happy://users/u_anna) ", drafts.last())
        assertEquals("ask @Anna Lee ", shown())
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().isEmpty() }
        input.performTextInput("about it")
        assertEquals("ask @Anna Lee about it", shown())
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("ask [Anna Lee](happy://users/u_anna) about it"), sent)
    }

    @Test
    fun aDeleteIntoAMentionTakesItWhole() {
        setScreen()
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("@kir")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        listRows()[0].performClick()
        rule.waitForIdle()
        assertEquals("@Kirill ", shown())
        input.performKeyInput { pressKey(Key.Backspace) }
        rule.waitForIdle()
        assertEquals("@Kirill", shown())
        input.performKeyInput { pressKey(Key.Backspace) }
        rule.waitForIdle()
        assertEquals("", shown())
        assertEquals("", drafts.last())
    }

    @Test
    fun aNewChatOffersTheTeamToo() {
        val skills = listOf(SlashCommand("code-review", true, "Review the current changes.", "skill"))
        setScreen(state = ConversationState(loaded = true, newWork = NewWork(WorkChoice()), commands = skills))
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("Fix the invoice export with @max")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        shot("mentions-new-chat")
        listRows()[0].performClick()
        rule.waitForIdle()
        assertEquals("Fix the invoice export with @Max Anders ", shown())
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("Fix the invoice export with [Max Anders](happy://users/u_max) "), sent)
        // "/" still opens the skills.
        input.performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        rule.onNode(hasText("/code-review"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun withoutATeamAnAtIsJustText() {
        setScreen(team = emptyList())
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("@anna")
        rule.waitForIdle()
        assertTrue(listRows().fetchSemanticsNodes().isEmpty())
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("@anna"), sent)
    }
}
