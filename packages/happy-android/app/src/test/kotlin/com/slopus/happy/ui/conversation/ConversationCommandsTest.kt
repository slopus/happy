package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.SlashCommand
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
 * A Happy Agent's slash commands over the conversation's composer
 * (desktop d04fbfef, 4078fd44, fd553cc3). Spec: "/" alone opens the list,
 * commands before skills, each a 48 row: a 32 tile 12 before "/name", then
 * the description and the kind at the end; 8 above the composer pill, 8 in
 * from its edges. Typing filters by the name's start; a word nothing
 * begins, a path or a second word is ordinary text and closes it. A tap
 * runs a command at once and clears the draft; a skill becomes "/name "
 * for its arguments, and Send runs it with them. Nothing goes as a message.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConversationCommandsTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Release notes", "idle", null, null, 1, 2, 0, 0)

    private val commands = listOf(
        SlashCommand("code-review", true, "Review the current changes.", "skill"),
        SlashCommand("compact", false, "Summarize older messages to free context space.", "compaction"),
        SlashCommand("deploy", true, "Ship the current build.", null, image = true, thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"),
    )

    private val rows = ConversationRowBuilder.build(Message("m1", "agent", 1, listOf(Block.Text("Ready when you are."))), "a1", null, false).asReversed()

    private val ran = ArrayList<Pair<String, String?>>()
    private val sent = ArrayList<String>()
    private val drafts = ArrayList<String>()

    private fun setScreen(dark: Boolean = false, state: ConversationState = ConversationState(created = true, loaded = true, rows = rows, agent = agent, commands = commands)) {
        rule.setHappyContent(dark) {
            ProvideWindowLayout {
                ConversationScreen(
                    state,
                    null,
                    ConversationScreenActions(
                        onDraftChange = { drafts += it },
                        onSend = { words, _ -> sent += words; true },
                        onCommand = { name, arguments -> ran += name to arguments; true },
                    ),
                )
            }
        }
    }

    private fun listRows() = rule.onAllNodesWithTag(AutocompleteTags.ROW, useUnmergedTree = true)

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun aSlashOpensTheCommandsBeforeTheSkillsOverTheComposer() {
        setScreen()
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 3 }
        val tops = listOf("compact", "deploy", "code-review").map { rule.onNode(hasText("/$it"), useUnmergedTree = true).bounds.top }
        assertEquals(tops.sortedBy { it.value }, tops)
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        val list = rule.node(AutocompleteTags.LIST).bounds
        assertBox("list", list, pill.left + 8.dp, pill.top - 8.dp - 144.dp, pill.right - pill.left - 16.dp, 144.dp)
        val first = listRows()[0].bounds
        assertDp("row height", first.bottom - first.top, 48.dp)
        val icon = rule.onAllNodesWithTag(AutocompleteTags.ICON, useUnmergedTree = true)[0].bounds
        assertBox("tile", icon, first.left + 16.dp, first.top + 8.dp, 32.dp, 32.dp)
        rule.onNode(hasText("Compaction"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("Skill"), useUnmergedTree = true).assertExists()
        shot("commands-light")
    }

    @Test
    fun theListInTheDark() {
        setScreen(dark = true)
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 3 }
        shot("commands-dark")
    }

    @Test
    fun typingFiltersByTheNamesStartAndAnythingElseIsText() {
        setScreen()
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("/co")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 2 }
        rule.onNode(hasText("/deploy"), useUnmergedTree = true).assertDoesNotExist()
        input.performTextReplacement("/Users/steve/project")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().isEmpty() }
        input.performTextReplacement("/nonsense")
        rule.waitForIdle()
        assertTrue(listRows().fetchSemanticsNodes().isEmpty())
        input.performTextReplacement("/compact now")
        rule.waitForIdle()
        assertTrue(listRows().fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aTapRunsACommandAndClearsTheDraft() {
        setScreen()
        rule.node(ConversationComposerTags.INPUT).performTextInput("/comp")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        listRows()[0].performClick()
        rule.waitForIdle()
        assertEquals(listOf<Pair<String, String?>>("compact" to null), ran)
        assertEquals("", drafts.last())
        assertTrue(sent.isEmpty())
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun aSkillTakesItsArgumentsAndSendRunsIt() {
        setScreen()
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("/code")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 1 }
        listRows()[0].performClick()
        rule.waitForIdle()
        assertTrue(ran.isEmpty())
        assertEquals("/code-review ", drafts.last())
        input.performTextInput("focus on auth")
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf<Pair<String, String?>>("code-review" to "focus on auth"), ran)
        assertTrue(sent.isEmpty())
    }

    @Test
    fun withoutCommandsASlashIsJustText() {
        setScreen(state = ConversationState(created = true, loaded = true, rows = rows, agent = agent))
        val input = rule.node(ConversationComposerTags.INPUT)
        input.performTextInput("/compact")
        rule.waitForIdle()
        assertTrue(listRows().fetchSemanticsNodes().isEmpty())
        rule.node(ConversationComposerTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("/compact"), sent)
        assertTrue(ran.isEmpty())
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onATabletTheListKeepsToTheComposersColumn() {
        setScreen()
        rule.node(ConversationComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { listRows().fetchSemanticsNodes().size == 3 }
        val pill = rule.node(ConversationComposerTags.PILL).bounds
        val list = rule.node(AutocompleteTags.LIST).bounds
        assertDp("left", list.left, pill.left)
        assertDp("right", list.right, pill.right)
        shot("commands-tablet")
    }
}
