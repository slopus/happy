package com.slopus.happy.ui.files

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.model.GitFileStatus
import com.slopus.happy.model.GitFileStatusKind
import com.slopus.happy.sync.GitFacts
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.diff.DiffTags
import com.slopus.happy.ui.diff.LocalDiffSyntax
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.layout.ProvideWindowLayout
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

/**
 * The changes, file, message detail and text selection screens against
 * happy-app's session/[id]/changes.tsx (AllFilesDiffView,
 * HappyAgentDiffView), session/[id]/file.tsx,
 * session/[id]/message/[messageId].tsx (ToolFullView) and
 * text-selection.tsx: the header titles; changes collapsed by default
 * with messages and Retry; the file's path bar padded 16 with a 20 icon
 * and the Diff / File tabs; the tool full view 12 down; the text in a
 * glass panel 16 in.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FilesLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        rule.setHappyContent { ProvideWindowLayout { CompositionLocalProvider(LocalDiffSyntax provides null) { content() } } }
    }

    private fun git(files: List<GitFile>, base: String? = "a".repeat(40), truncated: Boolean = false) = GitState(
        facts = GitFacts("main", false, "b".repeat(40), null, 0, 0),
        comparison = if (base != null) "ready" else "unavailable",
        base = base,
        changedFiles = files.size.toLong(),
        insertions = 0,
        deletions = 0,
        countsExact = true,
        conflicted = false,
        files = files,
        filesTruncated = truncated,
        scannedAt = 0.0,
    )

    /** TalkBack over the changes screen: the title is a header, Back a named button, nothing actionable unnamed. */
    @Test
    fun changesReadForTalkBack() {
        val status = GitFileStatus("a.kt", "src", "src/a.kt", GitFileStatusKind.Modified, false, 2, 1)
        val state = LegacyChanges.State(
            files = listOf(status),
            results = mapOf("src/a.kt" to LegacyChanges.Result(status, LegacyChanges.Content.Patch("--- a/src/a.kt\n+++ b/src/a.kt\n@@ -1 +1 @@\n-a\n+b\n"), null)),
            loadedOnce = true,
        )
        show { ChangesScreen(ChangesContent.Legacy(state), ChangesActions()) }
        rule.onNode(hasText("View changes") and isHeading(), useUnmergedTree = true).assertExists()
        rule.onNode(hasContentDescription("Back") and hasRole(Role.Button)).assertExists()
        rule.node(DiffTags.HEADER).performClick()
        rule.waitForIdle()
        rule.assertActionsLabelled()
    }

    @Test
    fun changesStartCollapsed() {
        val state = LegacyChanges.State(
            files = listOf(GitFileStatus("a.kt", "src", "src/a.kt", GitFileStatusKind.Modified, false, 2, 1)),
            results = mapOf("src/a.kt" to LegacyChanges.Result(
                GitFileStatus("a.kt", "src", "src/a.kt", GitFileStatusKind.Modified, false, 2, 1),
                LegacyChanges.Content.Patch("--- a/src/a.kt\n+++ b/src/a.kt\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"),
                null,
            )),
            loadedOnce = true,
        )
        show { ChangesScreen(ChangesContent.Legacy(state), ChangesActions()) }
        rule.onNodeWithText("View changes").assertExists()
        // Counted from the patch once it is in.
        rule.onNodeWithText("+2", useUnmergedTree = true).assertExists()
        rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true).assertCountEquals(0)
        val header = rule.node(DiffTags.HEADER).bounds
        val bar = rule.node(HeaderTags.BAR).bounds
        assertBox("file header under the bar", header, 0.dp, bar.bottom, PHONE_WIDTH.dp, header.height)
        rule.node(DiffTags.HEADER).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true).assertCountEquals(3)
    }

    @Test
    fun noChangesAndLoading() {
        var content by mutableStateOf<ChangesContent>(ChangesContent.Legacy(LegacyChanges.State(files = emptyList(), loadedOnce = true)))
        show { ChangesScreen(content, ChangesActions()) }
        rule.onNodeWithText("No changes to display").assertExists()
        content = ChangesContent.Loading
        rule.waitForIdle()
        rule.node(ChangesTags.SPINNER).assertExists()
    }

    @Test
    fun agentMessagesOfferRetry() {
        var retried = 0
        var content by mutableStateOf<ChangesContent>(ChangesContent.Agent(AgentChanges.State(load = AgentChanges.Load.Error("boom")), supported = true))
        show { ChangesScreen(content, ChangesActions(onRetry = { retried++ })) }
        rule.onNodeWithText("boom").assertExists()
        val message = rule.node(ChangesTags.MESSAGE).bounds
        val retry = rule.node(ChangesTags.RETRY).bounds
        assertDp("retry 8 below, padded 12", 8, retry.top - message.bottom)
        rule.node(ChangesTags.RETRY).performClick()
        assertEquals(1, retried)
        content = ChangesContent.Agent(AgentChanges.State(load = AgentChanges.Load.Ready(git(emptyList(), base = null), 1)), supported = true)
        rule.waitForIdle()
        rule.onNodeWithText("A comparison with origin/main is not available for this workspace.").assertExists()
        content = ChangesContent.Agent(AgentChanges.State(), supported = false)
        rule.waitForIdle()
        rule.onNodeWithText("Update Happy Agent on your computer to view changes in this session.").assertExists()
    }

    @Test
    fun agentFilesWithNotices() {
        val file = GitFile("src/a.kt", status = "modified", staged = false, unstaged = true, binary = false, insertions = 1, deletions = 1)
        val state = AgentChanges.State(
            load = AgentChanges.Load.Ready(git(listOf(file), truncated = true), 1),
            results = mapOf("src/a.kt" to AgentChanges.FileResult(GitFileContent.Text("a\n", "a\n"), null)),
        )
        val requested = ArrayList<String>()
        show { ChangesScreen(ChangesContent.Agent(state, true), ChangesActions(onRequestContent = { requested += it })) }
        rule.onNodeWithText("Showing 1 of 1 changed files. Open the workspace on your computer to see the full list.").assertExists()
        val notices = rule.node(ChangesTags.NOTICES).bounds
        val header = rule.node(DiffTags.HEADER).bounds
        assertDp("files under the notices", notices.bottom, header.top)
        rule.node(DiffTags.HEADER).performClick()
        rule.waitForIdle()
        // Same contents both sides: a message instead of a diff.
        rule.onNodeWithText("File contents match the comparison base.").assertExists()
        assertTrue(requested.isEmpty())
    }

    @Test
    fun fileViewerTabs() {
        val load = FileLoad.Loaded("val a = 1\n", "diff --git a/a.kt b/a.kt\n@@ -1 +1 @@\n-val a = 0\n+val a = 1")
        show { FileScreen(load, "/repo/src/a.kt", onBack = {}) }
        rule.onNodeWithText("File Viewer").assertExists()
        val bar = rule.node(FileTags.PATH_BAR).bounds
        val icon = rule.node(FileIconTags.ICON).bounds
        assertBox("icon", icon, 16.dp, bar.top + 16.dp, 20.dp, 20.dp)
        rule.onNodeWithText("/repo/src/a.kt").assertExists()
        val tabs = rule.node(FileTags.TOGGLE_BAR).bounds
        assertDp("tabs under the path", bar.bottom, tabs.top)
        val diffTab = rule.node(FileTags.DIFF_TAB).bounds
        val fileTab = rule.node(FileTags.FILE_TAB).bounds
        assertDp("tab 16 in", 16, diffTab.left)
        assertDp("tabs 8 apart", 8, fileTab.left - diffTab.right)
        rule.onAllNodesWithTag(FileTags.DIFF_LINE, useUnmergedTree = true).assertCountEquals(4)
        rule.node(FileTags.FILE_TAB).performClick()
        rule.waitForIdle()
        rule.node(FileTags.CODE).assertExists()
        val code = rule.node(FileTags.CODE).bounds
        assertDp("code padded 16", 16, code.left)
    }

    @Test
    fun fileViewerStates() {
        var load by mutableStateOf<FileLoad>(FileLoad.Loading)
        show { FileScreen(load, "/repo/logo.png", onBack = {}) }
        rule.onNodeWithText("Loading logo.png...").assertExists()
        load = FileLoad.Binary
        rule.waitForIdle()
        rule.onNodeWithText("Binary File").assertExists()
        rule.onNodeWithText("Cannot display binary file content").assertExists()
        load = FileLoad.Loaded("", null)
        rule.waitForIdle()
        rule.onNodeWithText("File is empty").assertExists()
        rule.onAllNodesWithTag(FileTags.TOGGLE_BAR, useUnmergedTree = true).assertCountEquals(0)
    }

    private fun tool(name: String, input: String, state: ToolState = ToolState.Completed, result: String? = null) = ChatMessage.ToolCallMessage(
        "m1", 0,
        ToolCall(name = name, state = state, input = Json.parseToJsonElement(input), createdAt = 0, result = result?.let(Json::parseToJsonElement)),
    )

    @Test
    fun messageDetailEdit() {
        show {
            MessageDetailScreen(tool("Edit", """{"file_path":"/repo/a.kt","old_string":"a","new_string":"b"}"""), true, MessageDetailEnvironment(path = "/repo"), onBack = {})
        }
        val content = rule.node(MessageDetailTags.CONTENT).bounds
        val bar = rule.node(HeaderTags.BAR).bounds
        // Edits run edge to edge, 12 down.
        val line = rule.onAllNodesWithTag(DiffTags.LINE, useUnmergedTree = true)[0].bounds
        assertDp("12 under the header", bar.bottom + 12.dp, line.top)
        assertDp("edge to edge", 0, content.left)
        assertTrue(line.right.value >= PHONE_WIDTH - 0.5f)
    }

    @Test
    fun messageDetailGenericAndBash() {
        var message by mutableStateOf<ChatMessage>(tool("Glob", """{"pattern":"*.kt"}""", result = "\"a.kt\""))
        show { MessageDetailScreen(message, true, MessageDetailEnvironment(), onBack = {}) }
        rule.onNodeWithText("Input Parameters").assertExists()
        rule.onNodeWithText("Output").assertExists()
        val content = rule.node(MessageDetailTags.CONTENT).bounds
        assertDp("16 in", 16, content.left)
        message = tool("Bash", """{"command":"ls"}""", result = """{"stdout":"a.kt"}""")
        rule.waitForIdle()
        rule.node(MessageDetailTags.COMMAND).assertExists()
        rule.onNodeWithText("$ ", substring = true, useUnmergedTree = true).assertExists()
        rule.onNodeWithText("a.kt", useUnmergedTree = true).assertExists()
        message = ChatMessage.AgentText("m2", 0, "hello there")
        rule.waitForIdle()
        val text = rule.node(MessageDetailTags.TEXT).bounds
        assertDp("text padded 16", 16, text.left)
    }

    @Test
    fun messageDetailLoading() {
        show { MessageDetailScreen(null, false, MessageDetailEnvironment(), onBack = {}) }
        rule.node(MessageDetailTags.SPINNER).assertExists()
        rule.onNodeWithText("Message").assertExists()
    }

    @Test
    fun patchFocusesTheTappedFile() {
        val input = """{"changes":{"/repo/a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b"},"/repo/b.ts":{"type":"add","content":"x"}}}"""
        show { MessageDetailScreen(tool("apply_patch", input), true, MessageDetailEnvironment(path = "/repo"), onBack = {}, focusFile = "/repo/b.ts") }
        rule.onAllNodesWithTag(MessageDetailTags.PATCH_FILE, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("NEW", useUnmergedTree = true).assertExists()
        val card = rule.node(MessageDetailTags.PATCH_FILE).bounds
        assertDp("card 12 in", 12, card.left)
    }

    @Test
    fun textSelection() {
        var copied = 0
        show { TextSelectionScreen("some long text", onBack = {}, onCopy = { copied++ }) }
        rule.onNodeWithText("Select Text").assertExists()
        val panel = rule.node(TextSelectionTags.PANEL).bounds
        val bar = rule.node(HeaderTags.BAR).bounds
        assertBox("panel", panel, 16.dp, bar.bottom + 16.dp, (PHONE_WIDTH - 32).dp, panel.height)
        val text = rule.node(TextSelectionTags.TEXT).bounds
        assertDp("text 16 in the panel", panel.left + 16.dp, text.left)
        assertTrue("at least 200 high", text.height.value >= 200)
        rule.node(TextSelectionTags.COPY).performClick()
        assertEquals(1, copied)
        assertDp("copy padded 8 around 24", 40, rule.node(TextSelectionTags.COPY).bounds.width)
    }

    @Test
    fun textSelectionLoading() {
        show { TextSelectionScreen(null, onBack = {}, onCopy = {}) }
        rule.onNodeWithText("Loading...").assertExists()
    }

    @Test
    fun toolPressesRoute() {
        assertEquals(SessionFileRoute("s", "/repo/a.kt"), toolPressRoute("s", tool("Edit", """{"file_path":"/repo/a.kt"}""")))
        assertEquals(MessageDetailRoute("s", "m1"), toolPressRoute("s", tool("Bash", """{"command":"ls"}""")))
    }

    @Suppress("unused")
    private val unused = DiffSource.Patch("")
}
