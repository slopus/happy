package com.slopus.happy.ui.autocomplete

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeyDown
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.autocomplete.FileItem
import com.slopus.happy.autocomplete.Suggestion
import com.slopus.happy.autocomplete.SuggestionSource
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatComposer
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/**
 * AgentInputAutocomplete over the composer. Spec: the `@` or `/` word at
 * the cursor asks for suggestions; the list sits over the chat, its bottom
 * 8 above the composer's inner container (the composer's own top, as the
 * container pads 8), 16 in from the screen edges (8 + 8), rows 48 high, at
 * most 320 tall. Picking a row swaps the whole active word for the pick
 * plus a space (none if one follows) and leaves the cursor after it.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class AutocompleteLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val queries = CopyOnWriteArrayList<String>()

    private val commands = listOf(
        Suggestion.Command("compact", "Compact the conversation history"),
        Suggestion.Command("context", null),
    )

    private val source = SuggestionSource { query ->
        queries += query
        when {
            query.startsWith("/") -> commands.filter { it.command.startsWith(query.drop(1)) }
            query.startsWith("@") -> listOf(
                Suggestion.FileMention("main.kt", "src/", "src/main.kt", FileItem.FileType.File),
                Suggestion.FileMention("src/", "", "src/", FileItem.FileType.Folder),
            )
            else -> emptyList()
        }
    }

    private var text = ""

    private fun setComposer(suggestions: SuggestionSource? = source, initial: String = "") {
        rule.setHappyContent {
            ProvideWindowLayout {
                CompositionLocalProvider(LocalSuggestionSource provides suggestions) {
                    Host(initial)
                }
            }
        }
    }

    @Composable
    private fun Host(initial: String) {
        var draft by remember { mutableStateOf(initial) }
        text = draft
        val autocomplete = rememberComposerAutocomplete(draft) { draft = it }
        Column(Modifier.fillMaxSize()) {
            Spacer(Modifier.weight(1f))
            ChatComposer(
                text = draft,
                onTextChange = { draft = it },
                status = null,
                primary = PrimaryAction.Idle,
                onPrimary = {},
                overlay = { ComposerSuggestions(autocomplete) },
                cursor = autocomplete.cursor,
            )
        }
    }

    private fun rows() = rule.onAllNodesWithTag(AutocompleteTags.ROW, useUnmergedTree = true)

    @Test
    fun theListSitsOverTheChatAboveTheComposer() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("/co")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        assertEquals("/co", queries.last())

        val composer = rule.node(ComposerTags.COMPOSER).bounds
        val list = rule.node(AutocompleteTags.LIST).bounds
        assertBox("list", list, 16.dp, composer.top - 96.dp, 379.dp, 96.dp)
        val first = rows()[0].bounds
        assertBox("first row", first, 16.dp, list.top, 379.dp, 48.dp)
        rule.onNode(hasText("/compact"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("Compact the conversation history"), useUnmergedTree = true).assertExists()
        // The composer keeps its height; the list takes no room.
        assertDp("composer bottom", rule.node(ComposerTags.COMPOSER).bounds.bottom, composer.bottom)
    }

    // On a 1280 tablet the composer's inner container is held to 800 and centred; the list is flush with it (wider than 700).
    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun onTabletsTheListKeepsToTheComposersWidth() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("/co")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        val panel = rule.node(ComposerTags.PANEL).bounds
        val list = rule.node(AutocompleteTags.LIST).bounds
        assertDp("list left", panel.left, list.left)
        assertDp("list right", panel.right, list.right)
        assertDp("held to 800", 800.dp, list.right - list.left)
    }

    @Test
    fun aLongListScrollsAt320() {
        val many = SuggestionSource { (1..20).map { Suggestion.Command("cmd$it", null) } }
        setComposer(many)
        rule.node(ComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().isNotEmpty() }
        assertDp("capped", 320.dp, rule.node(AutocompleteTags.LIST).bounds.let { it.bottom - it.top })
    }

    @Test
    fun pickingReplacesTheWordAndPutsTheCursorAfterIt() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("run /co")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        rows()[0].performClick()
        rule.waitForIdle()
        assertEquals("run /compact ", text)
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().isEmpty() }

        rule.node(ComposerTags.INPUT).performTextInput("now")
        rule.waitForIdle()
        assertEquals("run /compact now", text)
    }

    @Test
    fun pickingMidTextKeepsTheRestAndTheCursorInPlace() {
        setComposer(initial = "hello /co world")
        rule.node(ComposerTags.INPUT).performTextInputSelection(TextRange(9))
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        assertEquals("/co", queries.last())
        rows()[1].performClick()
        rule.waitForIdle()
        assertEquals("hello /context world", text)

        rule.node(ComposerTags.INPUT).performTextInput("!")
        rule.waitForIdle()
        assertEquals("hello /context! world", text)
    }

    @Test
    fun fileRowsShowTheIconPathAndKind() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("see @ma")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        assertEquals("@ma", queries.last())
        val row = rows()[0].bounds
        val icon = rule.onAllNodesWithTag(AutocompleteTags.ICON, useUnmergedTree = true)[0].bounds
        assertBox("icon", icon, row.left + 16.dp, row.top + 8.dp, 32.dp, 32.dp)
        rule.onNode(hasText("src/main.kt"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("FILE"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("FOLDER"), useUnmergedTree = true).assertExists()

        rows()[0].performClick()
        rule.waitForIdle()
        assertEquals("see @src/main.kt ", text)
    }

    @Test
    fun noActiveWordOrNoSessionMeansNoList() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("plain text")
        rule.waitForIdle()
        assertEquals(0, rows().fetchSemanticsNodes().size)
        assertEquals(emptyList<String>(), queries)
    }

    @Test
    fun withoutASourceNothingIsAsked() {
        setComposer(suggestions = null)
        rule.node(ComposerTags.INPUT).performTextInput("/co")
        rule.waitForIdle()
        assertEquals(0, rows().fetchSemanticsNodes().size)
        assertEquals("/co", text)
    }

    private fun row(text: String) =
        rule.onNode(hasTestTag(AutocompleteTags.ROW) and hasAnyDescendant(hasText(text)), useUnmergedTree = true)

    private fun press(key: Key, shift: Boolean = false) {
        rule.node(ComposerTags.INPUT).performKeyInput {
            if (shift) withKeyDown(Key.ShiftLeft) { pressKey(key) } else pressKey(key)
        }
        rule.waitForIdle()
    }

    // AgentInput handleKeyPress: arrows move (wrapping), Enter and Tab pick, Escape hides.
    @Test
    fun arrowsMoveTheSelectionAndWrap() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("/co")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        rows()[0].assertIsSelected()
        press(Key.DirectionDown)
        rows()[1].assertIsSelected()
        press(Key.DirectionDown)
        rows()[0].assertIsSelected()
        press(Key.DirectionUp)
        rows()[1].assertIsSelected()
        press(Key.Enter)
        assertEquals("/context ", text)
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun tabPicksButShiftTabDoesNot() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("/co")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        press(Key.Tab, shift = true)
        assertEquals("/co", text)
        press(Key.Tab)
        assertEquals("/compact ", text)
    }

    @Test
    fun escapeHidesTheListUntilTheWordChanges() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("/co")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 2 }
        press(Key.Escape)
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().isEmpty() }
        assertEquals("/co", text)
        // With the list gone, Enter is the field's again.
        press(Key.Enter)
        assertEquals("/co\n", text)
        rule.node(ComposerTags.INPUT).performTextReplacement("/con")
        rule.node(ComposerTags.INPUT).performTextInputSelection(TextRange(4))
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().size == 1 }
    }

    @Test
    fun withoutAListKeysReachTheField() {
        setComposer()
        rule.node(ComposerTags.INPUT).performTextInput("hi")
        press(Key.Enter)
        assertEquals("hi\n", text)
        assertEquals(emptyList<String>(), queries)
    }

    @Test
    fun keyboardSelectionScrollsTheListToKeepItInView() {
        val many = SuggestionSource { (1..20).map { Suggestion.Command("cmd$it", null) } }
        setComposer(many)
        rule.node(ComposerTags.INPUT).performTextInput("/")
        rule.waitUntil(5_000) { rows().fetchSemanticsNodes().isNotEmpty() }
        val list = rule.node(AutocompleteTags.LIST).bounds
        press(Key.DirectionUp)
        row("/cmd20").assertIsSelected()
        assertDp("last row at the bottom edge", list.bottom, row("/cmd20").bounds.bottom)
        press(Key.DirectionDown)
        assertDp("first row back at the top", list.top, row("/cmd1").bounds.top)
    }
}
