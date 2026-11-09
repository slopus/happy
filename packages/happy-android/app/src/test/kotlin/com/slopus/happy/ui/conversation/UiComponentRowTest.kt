package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.UiAnswer
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiActionRecord
import com.slopus.happy.conversation.ui.UiOffer
import com.slopus.happy.conversation.ui.UiOutcome
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Chat UI in the transcript ([UiComponentRow], [UnsentRow]), drawn from the wire as the daemon sends it. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiComponentRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Onboarding", "idle", null, null, 1, 2, 0, 0)

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** One agent message: words, then a `ui` block of [components]. */
    private fun offer(vararg components: String): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"text","text":"Pick one."},
                {"type":"ui","ui":{"id":"u1","components":[${components.joinToString(",")}]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false)
    }

    private val choice = """{"id":"pick","type":"choice","fallback":"Fix · Tests","props":{"options":[{"id":"fix","label":"Fix the login redirect","primary":true},{"id":"tests","label":"Run the tests"}]}}"""
    private val checklist = """{"id":"ais","type":"checklist","fallback":"Claude, Codex","props":{"options":[{"id":"claude","label":"Claude","detail":"Signed in"},{"id":"codex","label":"Codex","checked":true}],"submitLabel":"Use these","emptyLabel":"Continue without these"}}"""
    private val field = """{"id":"nick","type":"text_field","fallback":"Your nickname","props":{"label":"Your nickname","placeholder":"Ada","submitLabel":"Save"}}"""
    private val signIn = """{"id":"claude","type":"provider_sign_in","fallback":"Sign in to Claude in Happy on your computer","props":{"provider":"claude"}}"""
    private val phone = """{"id":"app","type":"phone_app","fallback":"Get Happy on your phone","props":{}}"""
    private val tree = """{"id":"files","type":"file_tree","fallback":"14 files","props":{"paths":[${(1..14).joinToString(",") { "\"src/file$it.ts\"" }}]}}"""

    private fun screen(rows: List<ConversationRow>, allows: (String) -> Boolean = { true }, pressed: MutableList<Pair<UiOffer, UiAction>> = ArrayList()) {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent),
                ConversationScreenActions(onUiAction = { offer, _, action -> pressed += offer to action; true }),
                roleAllows = allows,
            )
        }
        rule.waitForIdle()
    }

    @Test fun `a choice is its pills on the column, and a press sends the option`() {
        val pressed = ArrayList<Pair<UiOffer, UiAction>>()
        screen(offer(choice), pressed = pressed)
        val row = rule.node(UiTags.CHOICE).bounds
        val pills = rule.onAllNodesWithTag(UiTags.CHOICE_OPTION, useUnmergedTree = true)
        val first = pills[0].bounds
        val second = pills[1].bounds
        assertDp("16 in from the side", row.left + 16.dp, first.left)
        assertDp("36 high", 36.dp, first.bottom - first.top)
        assertTrue("8 apart, on one line or wrapped", second.left - first.right == 8.dp || second.top - first.bottom == 8.dp)
        shot("ui-choice-open")
        rule.onNodeWithText("Run the tests").performClick()
        assertEquals(listOf(UiOffer("m1", "u1", "pick") to UiAction.choose("tests")), pressed)
    }

    @Test fun `answered, the choice ticks what was sent and takes nothing more`() {
        val pressed = ArrayList<Pair<UiOffer, UiAction>>()
        val rows = offer(choice).map { if (it is ConversationRow.Ui) it.copy(answer = UiAnswer.Answered(UiAction.choose("tests"))) else it }
        screen(rows, pressed = pressed)
        rule.onAllNodesWithTag(UiTags.CHOICE_OPTION, useUnmergedTree = true)[1].assertIsSelected()
        rule.onNodeWithText("Fix the login redirect").performClick()
        assertTrue(pressed.isEmpty())
        shot("ui-choice-answered")
    }

    @Test fun `closed, or out of the person's role, it takes nothing and says why only for the role`() {
        val pressed = ArrayList<Pair<UiOffer, UiAction>>()
        screen(offer(choice).map { if (it is ConversationRow.Ui) it.copy(answer = UiAnswer.Closed) else it }, pressed = pressed)
        rule.onNodeWithText("Run the tests").performClick()
        rule.node(UiTags.NOT_ALLOWED).assertDoesNotExist()
        assertTrue(pressed.isEmpty())
    }

    @Test fun `a viewer sees the choice disabled with a line saying so`() {
        val pressed = ArrayList<Pair<UiOffer, UiAction>>()
        screen(offer(choice), allows = { it != "content.write" }, pressed = pressed)
        rule.node(UiTags.NOT_ALLOWED).assertExists()
        rule.onNodeWithText("Run the tests").performClick()
        assertTrue(pressed.isEmpty())
        shot("ui-choice-viewer")
    }

    @Test fun `a checklist sends its ticks, and its submit reads its empty label with none`() {
        val pressed = ArrayList<Pair<UiOffer, UiAction>>()
        screen(offer(checklist), pressed = pressed)
        rule.onNodeWithText("Use these").assertExists()
        rule.onNodeWithText("Codex").performClick()
        rule.onNodeWithText("Continue without these").assertExists()
        rule.onNodeWithText("Claude").performClick()
        shot("ui-checklist")
        rule.node(UiTags.SUBMIT).performClick()
        assertEquals(listOf(UiAction.submitChecklist(listOf("claude"))), pressed.map { it.second })
    }

    @Test fun `a text field sends what was typed once there is something`() {
        val pressed = ArrayList<Pair<UiOffer, UiAction>>()
        screen(offer(field), pressed = pressed)
        rule.node(UiTags.SUBMIT).performClick()
        assertTrue(pressed.isEmpty())
        rule.node(UiTags.TEXT_INPUT).performTextInput("  Ada ")
        rule.node(UiTags.SUBMIT).performClick()
        assertEquals(listOf(UiAction.submitText("Ada")), pressed.map { it.second })
        val input = rule.node(UiTags.TEXT_INPUT).bounds
        assertTrue("at least 40 high with its padding", input.bottom - input.top >= 20.dp)
    }

    @Test fun `without live sources live components are their fallback line, and phone_app is not on a phone`() {
        val rows = offer(signIn, phone, tree)
        assertEquals(listOf("provider_sign_in", "file_tree"), rows.filterIsInstance<ConversationRow.Ui>().map { it.component.type })
        screen(rows)
        rule.onNodeWithText("Sign in to Claude in Happy on your computer").assertExists()
        rule.onNodeWithText("Get Happy on your phone").assertDoesNotExist()
        // Twelve lines of the tree (its folder and eleven files), then all of them.
        rule.onNodeWithText("file11.ts").assertExists()
        rule.onNodeWithText("file12.ts").assertDoesNotExist()
        rule.onNodeWithText("Show all (15)").assertExists()
        shot("ui-fallback-and-tree")
        rule.node(UiTags.FILE_TREE_MORE).performClick()
        rule.onNodeWithText("file14.ts").assertExists()
    }

    @Test fun `a refused press is its words greyed, with why`() {
        val record = UiActionRecord(UiOffer("m1", "u1", "pick"), UiAction.choose("fix"), UiOutcome("rejected", "This was already answered.", "offer_closed"))
        screen(offer(choice) + ConversationRow.Unsent("k1:unsent", record, "Fix the login redirect"))
        rule.onNodeWithText("Not sent: This was already answered.").assertExists()
        assertEquals("the pill and the greyed bubble", 2, rule.onAllNodesWithText("Fix the login redirect", useUnmergedTree = true).fetchSemanticsNodes().size)
        shot("ui-unsent")
        val unsent = rule.node(UiTags.UNSENT).bounds
        val line = rule.node(UiTags.UNSENT_REASON).bounds
        assertDp("against the right edge, 16 in", unsent.right - 16.dp, line.right)
    }
}
