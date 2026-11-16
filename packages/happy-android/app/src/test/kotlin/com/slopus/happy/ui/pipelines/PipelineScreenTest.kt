package com.slopus.happy.ui.pipelines

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.pipelines.ClusterPipelines
import com.slopus.happy.pipelines.PipelineAcquire
import com.slopus.happy.pipelines.PipelineAuthor
import com.slopus.happy.pipelines.PipelineCompute
import com.slopus.happy.pipelines.PipelineConcurrency
import com.slopus.happy.pipelines.PipelineConcurrencyMode
import com.slopus.happy.pipelines.PipelineDefinition
import com.slopus.happy.pipelines.PipelineDetail
import com.slopus.happy.pipelines.PipelineEdge
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelinePermissions
import com.slopus.happy.pipelines.PipelineRunEntry
import com.slopus.happy.pipelines.PipelineRunListEntry
import com.slopus.happy.pipelines.PipelineRunState
import com.slopus.happy.pipelines.PipelineRunTrigger
import com.slopus.happy.pipelines.PipelineRuns
import com.slopus.happy.pipelines.PipelineType
import com.slopus.happy.pipelines.PipelineVersion
import com.slopus.happy.pipelines.PipelineVersionDetail
import com.slopus.happy.pipelines.PipelineVersionView
import com.slopus.happy.pipelines.PipelineView
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A pipeline's page, a version's and a version's node: what they say about the pipeline, read only. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class PipelineScreenTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private val agents = AgentNames { mapOf("a1" to "Release bot")[it] }
    private val people = PeopleNames { mapOf("u1" to "Steve")[it] }

    /** A row as one merged node, its words together. */
    private fun row(tag: String) = rule.onNode(hasTestTag(tag))

    private fun type(schema: String): PipelineType {
        val json = Json.parseToJsonElement(schema)
        return PipelineType(ClusterPipelines.schema(json)!!, json)
    }

    private val definition = PipelineDefinition(
        root = "build",
        // Listed out of graph order: the page orders them.
        nodes = listOf(
            PipelineNodeDefinition("triage", PipelineNodeKind.Agent, model = "anthropic/claude-sonnet-5", joinAny = true),
            PipelineNodeDefinition("deploy", PipelineNodeKind.Code, permissions = PipelinePermissions(secrets = listOf("PLAY")), compute = PipelineCompute(use = listOf("builder"))),
            PipelineNodeDefinition("test", PipelineNodeKind.Pipeline, pipelineId = "p-tests"),
            PipelineNodeDefinition(
                "build", PipelineNodeKind.Code,
                compute = PipelineCompute(acquire = listOf(PipelineAcquire("builder", "macs", null)), pass = listOf("builder")),
                output = type("""{"type":"object","properties":{"apk":{"type":"string"}},"required":["apk"]}"""),
                timeoutSeconds = 600,
            ),
        ),
        edges = listOf(
            PipelineEdge("build", "test", true), PipelineEdge("test", "deploy", true),
            PipelineEdge("build", "triage", false), PipelineEdge("deploy", "triage", false),
        ),
        input = type("""{"type":"object","properties":{"sha":{"type":"string"},"branch":{"type":["string","null"]},"mode":{"type":"string","enum":["fast","full"]}},"required":["sha"]}"""),
        concurrency = PipelineConcurrency(PipelineConcurrencyMode.Supersede, group = "{{ input.branch }}"),
        triggerAgents = listOf("a1", "bot9"),
    )

    private val head = PipelineVersion(3, "Supersede by branch", PipelineAuthor("u1", "a1"), now - 60 * minute)

    private val state = PipelineView(
        loading = false,
        name = "Deploy",
        pipeline = PipelineDetail("p1", "Deploy", "Ships main.", enabled = true, head = PipelineVersionDetail(head, definition)),
        versions = listOf(head, PipelineVersion(2, "", PipelineAuthor("u2", null), now - 2 * 60 * minute)),
        pipelineNames = mapOf("p-tests" to "Run tests"),
        runs = PipelineRuns(
            loading = false,
            entries = listOf(
                PipelineRunListEntry(
                    PipelineRunEntry("r1", 3, PipelineRunState.Running, PipelineRunTrigger.Agent("a1"), null, now - minute, now - minute, null),
                    "p1", "Deploy (as it was)", pipelineArchived = false,
                ),
            ),
            nextCursor = "r1",
        ),
    )

    @Test
    fun aPipelineSaysWhatItIsHowItRunsAndWhatItMayReach() {
        val nodes = mutableListOf<Pair<Int, String>>()
        val versions = mutableListOf<Int>()
        val runs = mutableListOf<String>()
        var more = 0
        rule.setHappyContent {
            PipelineScreen(
                state, agents, people, onRetry = {}, onMore = { more++ }, onBack = {},
                onOpenVersion = { versions += it }, onOpenNode = { version, node -> nodes += version to node }, onOpenRun = { runs += it }, now = now,
            )
        }
        rule.onNodeWithText("Ships main.").assertIsDisplayed()
        row(PipelineTags.STATUS).assertTextContains("Enabled")
        row(PipelineTags.HEAD).assertTextContains("v3")
        row(PipelineDefinitionTags.CONCURRENCY).assertTextContains("A new run aborts the one running and takes its place.")
        rule.onNodeWithText("{{ input.branch }}").assertIsDisplayed()
        // The graph in order from the root, each node's kind and where it leads; the root marked.
        val order = listOf("build", "test", "deploy", "triage").map { rule.node(PipelineDefinitionTags.node(it)).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(order.sorted(), order)
        row(PipelineDefinitionTags.node("build")).assertTextContains("Root").assertTextContains("Code\nOn success → test\nOn failure → triage")
        row(PipelineDefinitionTags.node("test")).assertTextContains("Runs Run tests\nOn success → deploy")
        row(PipelineDefinitionTags.node("triage")).assertTextContains("Agent · anthropic/claude-sonnet-5\nEnds the run")
        rule.node(PipelineDefinitionTags.node("test")).performClick()
        // The input field by field: its name, its type, whether it is required.
        row(PipelineDefinitionTags.field(PipelineDefinitionTags.INPUT, "sha")).performScrollTo().assertTextContains("string").assertTextContains("Required")
        row(PipelineDefinitionTags.field(PipelineDefinitionTags.INPUT, "branch")).assertTextContains("string | null").assertTextContains("Optional")
        row(PipelineDefinitionTags.field(PipelineDefinitionTags.INPUT, "mode")).assertTextContains("\"fast\" | \"full\"")
        // The output: each end's, under its node's name.
        rule.onNodeWithText("A run's result holds the output of each of these nodes that succeeded.").performScrollTo().assertIsDisplayed()
        // Who may start it, by name where known.
        rule.onNodeWithText("Release bot").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("bot9").performScrollTo().assertIsDisplayed()
        // The default is deny, and it is said so.
        rule.onNodeWithText("Nothing granted: its nodes can compute and nothing else.").performScrollTo().assertIsDisplayed()
        row(PipelineDefinitionTags.nodePermissions("deploy")).performScrollTo().assertTextContains("Secrets: PLAY")
        row(PipelineDefinitionTags.nodePermissions("build")).assertTextContains("Nothing granted")
        // Versions newest first; the head marked, a version without a message said so.
        row(PipelineTags.version(3)).performScrollTo().assertTextContains("v3 · Latest").assertTextContains("Release bot for Steve", substring = true)
        row(PipelineTags.version(2)).assertTextContains("No message", substring = true).assertTextContains("A member", substring = true)
        // Its runs as the list draws them, under its name as it is now.
        row(PipelinesTags.run("r1")).performScrollTo().assertTextContains("Deploy")
        rule.node(PipelinesTags.OLDER).performScrollTo().performClick()
        rule.node(PipelinesTags.run("r1")).performScrollTo().performClick()
        rule.node(PipelineTags.version(2)).performScrollTo().performClick()
        rule.node(PipelineDefinitionTags.nodePermissions("deploy")).performScrollTo().performClick()
        assertEquals(1, more)
        assertEquals(listOf("r1"), runs)
        assertEquals(listOf(2), versions)
        assertEquals("a node opens in the version on screen", listOf(3 to "test", 3 to "deploy"), nodes)
    }

    @Test
    fun aFieldIsAnItemsRow() {
        rule.setHappyContent { PipelineScreen(state, agents, people, {}, {}, {}, {}, { _, _ -> }, {}, now = now) }
        val field = rule.node(PipelineDefinitionTags.field(PipelineDefinitionTags.INPUT, "sha")).bounds
        assertDp("16, its name 24 over its type 20, 16", 76, field.bottom - field.top)
        val required = rule.onNode(hasText("Required") and hasAnyAncestor(hasTestTag(PipelineDefinitionTags.field(PipelineDefinitionTags.INPUT, "sha"))), useUnmergedTree = true).bounds
        assertDp("Required on the right, 16 in", 16, field.right - required.right)
    }

    @Test
    fun theJsonSchemaIsATapAway() {
        rule.setHappyContent { PipelineScreen(state, agents, people, {}, {}, {}, {}, { _, _ -> }, {}, now = now) }
        val raw = PipelineDefinitionTags.schema(PipelineDefinitionTags.INPUT)
        rule.node(raw).assertDoesNotExist()
        rule.node(PipelineDefinitionTags.schemaToggle(PipelineDefinitionTags.INPUT)).performScrollTo().performClick()
        rule.node(raw).performScrollTo()
        rule.onNodeWithText("\"required\"", substring = true).assertIsDisplayed()
        row(PipelineDefinitionTags.schemaToggle(PipelineDefinitionTags.INPUT)).assertTextContains("Hide JSON Schema")
    }

    @Test
    fun anArchivedPipelineKeepsOnlyItsRuns() {
        val archived = PipelineView(loading = false, missing = true, name = "Digest", runs = state.runs)
        rule.setHappyContent { PipelineScreen(archived, agents, people, {}, {}, {}, {}, { _, _ -> }, {}, now = now) }
        row(PipelineTags.STATUS).assertTextContains("Archived")
        row(PipelinesTags.run("r1")).assertTextContains("v3 · Archived", substring = true)
        rule.node(PipelineDefinitionTags.NODES).assertDoesNotExist()
    }

    @Test
    fun aVersionsNodeSaysWhatItMayReachAndHolds() {
        val opened = mutableListOf<String>()
        val version = PipelineVersionView(loading = false, version = PipelineVersionDetail(head, definition), pipelineNames = mapOf("p-tests" to "Run tests"))
        val shown = androidx.compose.runtime.mutableStateOf("build")
        rule.setHappyContent { PipelineVersionNodeScreen(version, shown.value, agents, onRetry = {}, onBack = {}, onOpenNode = { opened += it }) }
        row(PipelineVersionTags.SUMMARY).assertTextContains("Code").assertTextContains("v3 · Root")
        rule.onNodeWithText("The root: a run starts here, with the pipeline's input.").assertIsDisplayed()
        rule.onNodeWithText("Next when this node fails").assertIsDisplayed()
        rule.onNodeWithText("None. It can use the computers it holds and nothing else.").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("builder from macs").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("10 min").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("test").performScrollTo().performClick()
        assertEquals(listOf("test"), opened)
        shown.value = "triage"
        rule.onAllNodesWithText("Leads here when it fails").assertCountEquals(2)
        rule.onNodeWithText("Any edge into it fired").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("The server's default").assertDoesNotExist()
    }

    @Test
    fun typesReadAsTypeScript() {
        assertEquals("{ sha: string; branch?: string | null }", schemaText(type("""{"type":"object","properties":{"sha":{"type":"string"},"branch":{"type":["string","null"]}},"required":["sha"]}""").schema))
        assertEquals("(\"a\" | \"b\")[]", schemaText(type("""{"type":"array","items":{"type":"string","enum":["a","b"]}}""").schema))
        assertEquals(
            "a long object puts each field on its own line",
            "{\n  repository: string;\n  pullRequest: integer;\n  labels?: string[];\n}",
            schemaText(type("""{"type":"object","properties":{"repository":{"type":"string"},"pullRequest":{"type":"integer"},"labels":{"type":"array","items":{"type":"string"}}},"required":["repository","pullRequest"]}""").schema),
        )
    }
}
