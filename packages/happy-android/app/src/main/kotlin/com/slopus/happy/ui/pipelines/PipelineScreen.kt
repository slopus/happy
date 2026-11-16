package com.slopus.happy.ui.pipelines

import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.pipelines.PipelineDefinition
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelineVersion
import com.slopus.happy.pipelines.PipelineVersionView
import com.slopus.happy.pipelines.PipelineView
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.theme.HappyTheme

object PipelineTags {
    const val LIST = "pipelines.pipelinePage.list"
    const val RETRY = "pipelines.pipelinePage.retry"
    const val STATUS = "pipelines.pipelinePage.status"
    const val HEAD = "pipelines.pipelinePage.head"
    const val UNREADABLE = "pipelines.pipelinePage.unreadable"
    const val VERSIONS = "pipelines.pipelinePage.versions"
    fun version(number: Int) = "pipelines.pipelinePage.version.$number"
}

object PipelineVersionTags {
    const val LIST = "pipelines.versionPage.list"
    const val RETRY = "pipelines.versionPage.retry"
    const val SUMMARY = "pipelines.versionPage.summary"
    const val LEADS = "pipelines.versionPage.leads"
    const val NODE_INPUT = "pipelines.versionPage.node.input"
    const val NODE_OUTPUT = "pipelines.versionPage.node.output"
    const val NODE_PERMISSIONS = "pipelines.versionPage.node.permissions"
    const val WORK = "pipelines.versionPage.node.work"
}

/**
 * One pipeline, live and read only (desktop's pipeline page): what it is
 * for, whether it takes runs and how they share it, then everything its
 * current version defines ([DefinitionGroups]), its versions newest first
 * and its runs as the list draws them, paging the same way. An archived
 * pipeline keeps only its runs. A version opens its page ([onOpenVersion]),
 * a node its page in the current version ([onOpenNode]), a run its own.
 */
@Composable
fun PipelineScreen(
    state: PipelineView,
    agents: AgentNames,
    people: PeopleNames,
    onRetry: () -> Unit,
    onMore: () -> Unit,
    onBack: () -> Unit,
    onOpenVersion: (number: Int) -> Unit,
    onOpenNode: (version: Int, nodeId: String) -> Unit,
    onOpenRun: (runId: String) -> Unit,
    now: Long = rememberNow(state.live),
) {
    val colors = HappyTheme.colors
    val pipeline = state.pipeline
    Screen(header = { StackHeader(state.name ?: stringResource(R.string.pipelines_pipeline_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(PipelineTags.LIST)) {
            when {
                pipeline == null && state.missing -> {
                    ItemGroup(footer = stringResource(R.string.pipelines_archived_footer)) {
                        Item(title = stringResource(R.string.pipelines_archived), titleColor = colors.textSecondary, showChevron = false, modifier = Modifier.testTag(PipelineTags.STATUS))
                    }
                    PipelineRuns(state, agents, now, onMore, onOpenRun)
                }
                pipeline == null && state.loading -> ItemGroup { Item(title = stringResource(R.string.pipelines_pipeline_loading), loading = true, showChevron = false) }
                pipeline == null -> ItemGroup {
                    Item(
                        title = stringResource(R.string.pipelines_pipeline_failed),
                        subtitle = stringResource(R.string.pipelines_tap_to_retry),
                        onClick = onRetry,
                        showChevron = false,
                        modifier = Modifier.testTag(PipelineTags.RETRY),
                    )
                }
                else -> {
                    val head = pipeline.head
                    val definition = head.definition
                    ItemGroup(footer = if (state.failed) stringResource(R.string.pipelines_out_of_date) else null) {
                        pipeline.description?.let { Item(title = it, titleLines = 0, showChevron = false) }
                        Item(
                            title = stringResource(R.string.pipelines_status),
                            subtitle = stringResource(if (pipeline.enabled) R.string.pipelines_enabled_words else R.string.pipelines_disabled_words),
                            subtitleLines = 0,
                            detail = stringResource(if (pipeline.enabled) R.string.pipelines_enabled else R.string.pipelines_disabled),
                            detailColor = if (pipeline.enabled) colors.success else colors.textSecondary,
                            showChevron = false,
                            modifier = Modifier.testTag(PipelineTags.STATUS),
                        )
                        Item(
                            title = stringResource(R.string.pipelines_current_version),
                            detail = stringResource(R.string.pipelines_version, head.version.number),
                            onClick = { onOpenVersion(head.version.number) },
                            modifier = Modifier.testTag(PipelineTags.HEAD),
                        )
                        definition?.let { ConcurrencyItems(it.concurrency) }
                    }
                    if (definition != null) {
                        DefinitionGroups(definition, agents, state.pipelineNames) { onOpenNode(head.version.number, it) }
                    } else {
                        ItemGroup { NoteItem(stringResource(R.string.pipelines_version_unreadable), Modifier.testTag(PipelineTags.UNREADABLE)) }
                    }
                    ItemGroup(title = stringResource(R.string.pipelines_versions), modifier = Modifier.testTag(PipelineTags.VERSIONS)) {
                        if (state.versions.isEmpty()) Item(title = stringResource(R.string.pipelines_versions_loading), loading = !state.failed, showChevron = false)
                        state.versions.forEach { version -> VersionRow(version, head.version.number, agents, people) { onOpenVersion(version.number) } }
                    }
                    PipelineRuns(state, agents, now, onMore, onOpenRun)
                }
            }
        }
    }
}

/** The pipeline's runs as the list draws them, under its name as it is now. */
@Composable
private fun PipelineRuns(state: PipelineView, agents: AgentNames, now: Long, onMore: () -> Unit, onOpenRun: (String) -> Unit) {
    val name = state.pipeline?.name ?: state.name
    val runs = remember(state.runs, name, state.missing) {
        state.runs.copy(entries = state.runs.entries.map { it.copy(pipelineName = name ?: it.pipelineName, pipelineArchived = state.missing) })
    }
    RunsGroup(runs, agents, now, stringResource(R.string.pipelines_runs_empty), onMore, onOpenRun)
}

/** One version: its number (and Latest), its message, who published it and when. */
@Composable
private fun VersionRow(version: PipelineVersion, head: Int, agents: AgentNames, people: PeopleNames, onOpen: () -> Unit) {
    val number = stringResource(R.string.pipelines_version, version.number)
    Item(
        title = if (version.number == head) stringResource(R.string.pipelines_version_latest, number) else number,
        subtitle = listOf(
            version.message.ifBlank { stringResource(R.string.pipelines_version_no_message) },
            "${authorWords(version.author, agents, people)} · ${pipelineTime(version.createdAt)}",
        ).joinToString("\n"),
        subtitleLines = 4,
        onClick = onOpen,
        modifier = Modifier.testTag(PipelineTags.version(version.number)),
    )
}

/**
 * One version of a pipeline, read only: its number, message, author and
 * time, how its runs share the pipeline, then everything it defines the
 * way the pipeline page shows its current version.
 */
@Composable
fun PipelineVersionScreen(
    state: PipelineVersionView,
    pipelineName: String?,
    agents: AgentNames,
    people: PeopleNames,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    onOpenNode: (nodeId: String) -> Unit,
) {
    val detail = state.version
    Screen(header = { StackHeader(pipelineName ?: stringResource(R.string.pipelines_pipeline_title), onBack) }) {
        ItemList(modifier = Modifier.testTag(PipelineVersionTags.LIST)) {
            if (detail == null) return@ItemList VersionAbsent(state, onRetry)
            val version = detail.version
            ItemGroup {
                Item(
                    title = stringResource(R.string.pipelines_version_title, version.number),
                    subtitle = version.message.ifBlank { stringResource(R.string.pipelines_version_no_message) },
                    subtitleLines = 0,
                    showChevron = false,
                    modifier = Modifier.testTag(PipelineVersionTags.SUMMARY),
                )
                Item(title = stringResource(R.string.pipelines_version_by), detail = authorWords(version.author, agents, people), showChevron = false)
                Item(title = stringResource(R.string.pipelines_version_published), detail = pipelineTime(version.createdAt), showChevron = false)
                detail.definition?.let { ConcurrencyItems(it.concurrency) }
            }
            val definition = detail.definition ?: return@ItemList ItemGroup { NoteItem(stringResource(R.string.pipelines_version_unreadable)) }
            DefinitionGroups(definition, agents, state.pipelineNames, onOpenNode)
        }
    }
}

@Composable
private fun VersionAbsent(state: PipelineVersionView, onRetry: () -> Unit) = when {
    state.loading -> ItemGroup { Item(title = stringResource(R.string.pipelines_version_loading), loading = true, showChevron = false) }
    state.missing -> ItemGroup { NoteItem(stringResource(R.string.pipelines_version_missing)) }
    else -> ItemGroup {
        Item(
            title = stringResource(R.string.pipelines_version_failed),
            subtitle = stringResource(R.string.pipelines_tap_to_retry),
            onClick = onRetry,
            showChevron = false,
            modifier = Modifier.testTag(PipelineVersionTags.RETRY),
        )
    }
}

/**
 * One node as a version defines it, read only (desktop's
 * `PipelineNodeFacts` and `PipelineNodeWork`): what it is, where it sits in
 * the graph, its types, what it may reach, the computers it holds, its
 * limits, and its source, instructions or child pipeline.
 */
@Composable
fun PipelineVersionNodeScreen(
    state: PipelineVersionView,
    nodeId: String,
    agents: AgentNames,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    onOpenNode: (nodeId: String) -> Unit,
) {
    val resources = LocalResources.current
    Screen(header = { StackHeader(nodeId, onBack) }) {
        ItemList(modifier = Modifier.testTag(PipelineVersionTags.LIST)) {
            val detail = state.version ?: return@ItemList VersionAbsent(state, onRetry)
            val definition = detail.definition ?: return@ItemList ItemGroup { NoteItem(stringResource(R.string.pipelines_version_unreadable)) }
            val node = definition.node(nodeId) ?: return@ItemList ItemGroup { NoteItem(stringResource(R.string.pipelines_node_missing)) }
            val pipelineName = { id: String -> state.pipelineNames[id] ?: id }
            ItemGroup {
                Item(
                    // An agent's model has its own row below.
                    title = if (node.kind == PipelineNodeKind.Agent) stringResource(R.string.pipelines_kind_agent) else nodeKindWords(node.kind, node, pipelineName),
                    subtitle = listOfNotNull(
                        stringResource(R.string.pipelines_version, detail.version.number),
                        stringResource(R.string.pipelines_root).takeIf { node.id == definition.root },
                    ).joinToString(" · "),
                    icon = { KindTile(node.kind) },
                    showChevron = false,
                    modifier = Modifier.testTag(PipelineVersionTags.SUMMARY),
                )
                if (node.kind == PipelineNodeKind.Agent) {
                    Item(title = stringResource(R.string.pipelines_usage_model), detail = node.model ?: stringResource(R.string.pipelines_model_default), showChevron = false)
                    node.effort?.let { Item(title = stringResource(R.string.pipelines_effort), detail = it, showChevron = false) }
                }
            }
            Leads(definition, node, onOpenNode)
            ItemGroup(title = stringResource(R.string.pipelines_input), modifier = Modifier.testTag(PipelineVersionTags.NODE_INPUT)) {
                TypeItems(node.input, stringResource(R.string.pipelines_type_from_edge), PipelineVersionTags.NODE_INPUT)
            }
            ItemGroup(title = stringResource(R.string.pipelines_output), modifier = Modifier.testTag(PipelineVersionTags.NODE_OUTPUT)) {
                TypeItems(node.output, stringResource(R.string.pipelines_type_not_declared), PipelineVersionTags.NODE_OUTPUT)
            }
            ItemGroup(title = stringResource(R.string.pipelines_permissions), modifier = Modifier.testTag(PipelineVersionTags.NODE_PERMISSIONS)) {
                PermissionItems(node.permissions, stringResource(R.string.pipelines_node_permissions_none), agents, pipelineName)
            }
            ItemGroup(title = stringResource(R.string.pipelines_computers)) { ComputeItems(node.compute) }
            ItemGroup(title = stringResource(R.string.pipelines_limits)) {
                Item(title = stringResource(R.string.pipelines_timeout), detail = timeoutText(resources, node.timeoutSeconds), showChevron = false)
                if (definition.incoming(node.id) > 1) {
                    Item(title = stringResource(R.string.pipelines_join), subtitle = stringResource(if (node.joinAny) R.string.pipelines_join_any else R.string.pipelines_join_all), showChevron = false)
                }
            }
            Work(node, pipelineName)
        }
    }
}

/** Where the node sits: what comes before it, and where success and failure lead, each node a row that opens it. */
@Composable
private fun Leads(definition: PipelineDefinition, node: PipelineNodeDefinition, onOpenNode: (String) -> Unit) {
    val before = definition.edges.filter { it.to == node.id }
    ItemGroup(title = stringResource(R.string.pipelines_in_graph), modifier = Modifier.testTag(PipelineVersionTags.LEADS)) {
        if (before.isEmpty()) NoteItem(stringResource(R.string.pipelines_root_words))
        before.forEach { edge ->
            Item(
                title = edge.from,
                subtitle = stringResource(if (edge.onSuccess) R.string.pipelines_after_success else R.string.pipelines_after_failure),
                icon = { definition.node(edge.from)?.let { KindTile(it.kind) } },
                onClick = { onOpenNode(edge.from) },
            )
        }
        val after = definition.edges.filter { it.from == node.id }
        if (after.none { it.onSuccess }) NoteItem(stringResource(R.string.pipelines_ends_run_words))
        after.forEach { edge ->
            Item(
                title = edge.to,
                subtitle = stringResource(if (edge.onSuccess) R.string.pipelines_then_on_success else R.string.pipelines_then_on_failure),
                icon = { definition.node(edge.to)?.let { KindTile(it.kind) } },
                onClick = { onOpenNode(edge.to) },
            )
        }
    }
}

/** What the node runs: its source, its instructions, or the pipeline it starts. */
@Composable
private fun Work(node: PipelineNodeDefinition, pipelineName: (String) -> String) {
    when (node.kind) {
        PipelineNodeKind.Code -> ItemGroup(title = stringResource(R.string.pipelines_source)) {
            val source = node.source
            if (source.isNullOrEmpty()) NoteItem(stringResource(R.string.pipelines_source_none)) else MonoBlock(source.trimEnd(), Modifier.testTag(PipelineVersionTags.WORK))
        }
        PipelineNodeKind.Agent -> ItemGroup(title = stringResource(R.string.pipelines_instructions)) {
            val instructions = node.instructions
            if (instructions.isNullOrBlank()) {
                NoteItem(stringResource(R.string.pipelines_instructions_none))
            } else {
                val blocks = remember(instructions) { parseMarkdown(instructions) }
                MarkdownView(blocks, Modifier.padding(horizontal = ItemSpec.paddingHorizontal, vertical = ItemSpec.paddingVertical).testTag(PipelineVersionTags.WORK))
            }
        }
        PipelineNodeKind.Pipeline -> ItemGroup(title = stringResource(R.string.pipelines_child_pipeline)) {
            NoteItem(stringResource(R.string.pipelines_child_pipeline_words, pipelineName(node.pipelineId.orEmpty())), Modifier.testTag(PipelineVersionTags.WORK))
        }
    }
}
