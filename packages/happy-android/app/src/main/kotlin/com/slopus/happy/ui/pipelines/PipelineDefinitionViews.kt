package com.slopus.happy.ui.pipelines

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.pipelines.PipelineAuthor
import com.slopus.happy.pipelines.PipelineCompute
import com.slopus.happy.pipelines.PipelineConcurrency
import com.slopus.happy.pipelines.PipelineConcurrencyMode
import com.slopus.happy.pipelines.PipelineDefinition
import com.slopus.happy.pipelines.PipelineGrant
import com.slopus.happy.pipelines.PipelineNodeDefinition
import com.slopus.happy.pipelines.PipelineNodeKind
import com.slopus.happy.pipelines.PipelinePermissions
import com.slopus.happy.pipelines.PipelineSchema
import com.slopus.happy.pipelines.PipelineType
import com.slopus.happy.pipelines.pipelineNodeOrder
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.connection.TileMark
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object PipelineDefinitionTags {
    const val NODES = "pipelines.definition.nodes"
    const val INPUT = "pipelines.definition.input"
    const val OUTPUT = "pipelines.definition.output"
    const val TRIGGERS = "pipelines.definition.triggers"
    const val PERMISSIONS = "pipelines.definition.permissions"
    const val NODE_PERMISSIONS = "pipelines.definition.nodePermissions"
    const val CONCURRENCY = "pipelines.definition.concurrency"
    fun node(id: String) = "pipelines.definition.node.$id"
    fun nodePermissions(id: String) = "pipelines.definition.nodePermissions.$id"
    fun field(group: String, name: String) = "$group.field.$name"
    fun schemaToggle(group: String) = "$group.schema"
    fun schema(group: String) = "$group.schema.json"
}

/** Names whoever published a version; null where this phone doesn't know them. */
fun interface PeopleNames {
    fun name(userId: String): String?
}

/** A type's monospaced line under a field's name. */
private val typeStyle = ItemSpec.subtitle.copy(fontFamily = FontFamily.Monospace)

private const val INLINE_LIMIT = 48

/**
 * A type as one reads it in TypeScript (desktop's `pipelineSchemaText`):
 * `{ sha: string; branch?: string }`, `string[]`, `"a" | "b"`, `T | null`.
 * An object too long for one line puts each field on its own, indented.
 */
internal fun schemaText(schema: PipelineSchema, indent: String = ""): String {
    fun nullable(text: String) = if (schema.nullable) "$text | null" else text
    return when (schema) {
        PipelineSchema.Null -> "null"
        is PipelineSchema.ListOf -> {
            val items = schemaText(schema.items, indent)
            nullable(if ((' ' in items || '|' in items) && !items.startsWith("{")) "($items)[]" else "$items[]")
        }
        is PipelineSchema.ObjectOf -> {
            if (schema.fields.isEmpty()) return nullable("{}")
            val inner = "$indent  "
            val parts = schema.fields.map { "${it.name}${if (it.required) "" else "?"}: ${schemaText(it.schema, inner)}" }
            val inline = "{ ${parts.joinToString("; ")} }"
            nullable(if (inline.length <= INLINE_LIMIT && '\n' !in inline) inline else "{\n${parts.joinToString("\n") { "$inner$it;" }}\n$indent}")
        }
        is PipelineSchema.Scalar -> nullable(schema.values?.joinToString(" | ", transform = JsonPrimitive::toString) ?: schema.type)
    }
}

/** Seconds as the largest whole unit that fits: "1 h", "10 min", "90 s" (desktop's `pipelineDurationText`). */
internal fun timeoutText(resources: Resources, seconds: Long): String = when {
    seconds % 3600 == 0L -> resources.getString(R.string.pipelines_timeout_hours, (seconds / 3600).toInt())
    seconds % 60 == 0L -> resources.getString(R.string.pipelines_timeout_minutes, (seconds / 60).toInt())
    else -> resources.getString(R.string.pipelines_timeout_seconds, seconds.toInt())
}

/** A node's kind on its tile: code blue, agent indigo, a child pipeline teal as the pipelines row. */
@Composable
internal fun KindTile(kind: PipelineNodeKind) = when (kind) {
    PipelineNodeKind.Code -> TileMark(Ionicon.CodeSlashOutline, RowTile.Blue, ItemSpec.iconSize)
    PipelineNodeKind.Agent -> TileMark(Ionicon.SparklesOutline, RowTile.Indigo, ItemSpec.iconSize)
    PipelineNodeKind.Pipeline -> TileMark(Ionicon.GitNetworkOutline, RowTile.Teal, ItemSpec.iconSize)
}

/** Who published a version: a member, an agent and the member it acted for, or Unknown. */
@Composable
internal fun authorWords(author: PipelineAuthor?, agents: AgentNames, people: PeopleNames): String {
    val agentId = author?.agentId
    val person = author?.userId?.let { people.name(it) ?: stringResource(R.string.pipelines_author_a_member) }
    return when {
        author == null -> stringResource(R.string.pipelines_started_by_unknown)
        agentId == null -> person!!
        else -> {
            val agent = agents.name(agentId) ?: stringResource(R.string.pipelines_started_by_an_agent)
            if (person == null) agent else stringResource(R.string.pipelines_author_agent_for, agent, person)
        }
    }
}

/** How runs share the pipeline, in words: the mode, the group key when there is one, and batching when it is on. */
@Composable
internal fun ConcurrencyItems(concurrency: PipelineConcurrency) {
    Item(
        title = stringResource(R.string.pipelines_concurrency),
        subtitle = stringResource(
            when (concurrency.mode) {
                PipelineConcurrencyMode.Independent -> R.string.pipelines_concurrency_independent
                PipelineConcurrencyMode.Supersede -> R.string.pipelines_concurrency_supersede
                PipelineConcurrencyMode.Queue -> R.string.pipelines_concurrency_queue
            },
        ),
        subtitleLines = 0,
        showChevron = false,
        modifier = Modifier.testTag(PipelineDefinitionTags.CONCURRENCY),
    )
    concurrency.group?.let {
        Item(title = stringResource(R.string.pipelines_concurrency_group), subtitle = it, subtitleStyle = typeStyle, subtitleLines = 0, showChevron = false)
    }
    if (concurrency.batch) {
        Item(title = stringResource(R.string.pipelines_concurrency_batch), subtitle = stringResource(R.string.pipelines_concurrency_batch_words), subtitleLines = 0, showChevron = false)
    }
}

/**
 * Everything a version defines, as the pipeline and version pages show it:
 * its nodes in graph order (each with its kind, where success and failure
 * lead, and the root marked), its input and output types field by field,
 * who may start it, what it may reach, and what each node may. A node opens
 * its page ([onOpenNode]).
 */
@Composable
internal fun DefinitionGroups(definition: PipelineDefinition, agents: AgentNames, pipelineNames: Map<String, String>, onOpenNode: (String) -> Unit) {
    val pipelineName = { id: String -> pipelineNames[id] ?: id }
    NodeGraph(definition, pipelineName, onOpenNode)
    ItemGroup(title = stringResource(R.string.pipelines_input), footer = stringResource(R.string.pipelines_input_footer), modifier = Modifier.testTag(PipelineDefinitionTags.INPUT)) {
        TypeItems(definition.input, stringResource(R.string.pipelines_type_any), PipelineDefinitionTags.INPUT)
    }
    Output(definition)
    ItemGroup(title = stringResource(R.string.pipelines_triggers), footer = stringResource(R.string.pipelines_triggers_footer), modifier = Modifier.testTag(PipelineDefinitionTags.TRIGGERS)) {
        if (definition.triggerAgents.isEmpty()) NoteItem(stringResource(R.string.pipelines_triggers_none))
        definition.triggerAgents.forEach { id ->
            val name = agents.name(id)
            Item(title = name ?: id, subtitle = id.takeIf { name != null }, icon = { TileMark(Ionicon.SparklesOutline, RowTile.Indigo, ItemSpec.iconSize) }, showChevron = false)
        }
    }
    ItemGroup(title = stringResource(R.string.pipelines_permissions), footer = stringResource(R.string.pipelines_permissions_footer), modifier = Modifier.testTag(PipelineDefinitionTags.PERMISSIONS)) {
        PermissionItems(definition.permissions, stringResource(R.string.pipelines_permissions_none), agents, pipelineName)
    }
    ItemGroup(title = stringResource(R.string.pipelines_node_permissions), modifier = Modifier.testTag(PipelineDefinitionTags.NODE_PERMISSIONS)) {
        val resources = LocalResources.current
        definition.nodes.forEach { node ->
            val facts = permissionFacts(resources, node.permissions ?: PipelinePermissions(), agents, pipelineName)
            Item(
                title = node.id,
                subtitle = if (facts.isEmpty()) stringResource(R.string.pipelines_nothing_granted) else facts.joinToString("\n") { (label, value) -> "$label: $value" },
                subtitleLines = 0,
                icon = { KindTile(node.kind) },
                onClick = { onOpenNode(node.id) },
                modifier = Modifier.testTag(PipelineDefinitionTags.nodePermissions(node.id)),
            )
        }
    }
}

/** The nodes in graph order, the root first: what each is and where it leads. */
@Composable
private fun NodeGraph(definition: PipelineDefinition, pipelineName: (String) -> String, onOpenNode: (String) -> Unit) {
    val order = remember(definition) { pipelineDefinitionOrder(definition) }
    ItemGroup(title = stringResource(R.string.pipelines_nodes), footer = stringResource(R.string.pipelines_graph_footer), modifier = Modifier.testTag(PipelineDefinitionTags.NODES)) {
        order.forEach { node ->
            Item(
                title = node.id,
                subtitle = (listOf(nodeKindWords(node.kind, node, pipelineName)) + leadsTo(definition, node.id)).joinToString("\n"),
                subtitleLines = 0,
                detail = stringResource(R.string.pipelines_root).takeIf { node.id == definition.root },
                icon = { KindTile(node.kind) },
                onClick = { onOpenNode(node.id) },
                modifier = Modifier.testTag(PipelineDefinitionTags.node(node.id)),
            )
        }
    }
}

/** The definition's nodes as [pipelineNodeOrder] orders a run's: by their column from the root, ties as listed. */
internal fun pipelineDefinitionOrder(definition: PipelineDefinition): List<PipelineNodeDefinition> =
    pipelineNodeOrder(definition, emptyList()).mapNotNull(definition::node)

/** Where a node leads, a line each: "On success → deploy", "On failure → triage", or "Ends the run". */
@Composable
internal fun leadsTo(definition: PipelineDefinition, id: String): List<String> {
    val success = definition.next(id, onSuccess = true)
    val failure = definition.next(id, onSuccess = false)
    return listOfNotNull(
        if (success.isEmpty()) stringResource(R.string.pipelines_ends_run) else stringResource(R.string.pipelines_on_success, success.joinToString(", ")),
        failure.takeIf { it.isNotEmpty() }?.let { stringResource(R.string.pipelines_on_failure, it.joinToString(", ")) },
    )
}

/** The run's result: each end node's output, field by field, under its node's name when there are several. */
@Composable
private fun Output(definition: PipelineDefinition) {
    val ends = definition.ends
    val footer = if (ends.size == 1) stringResource(R.string.pipelines_output_footer_one, ends[0].id) else stringResource(R.string.pipelines_output_footer)
    ItemGroup(title = stringResource(R.string.pipelines_output), footer = footer, modifier = Modifier.testTag(PipelineDefinitionTags.OUTPUT)) {
        val notDeclared = stringResource(R.string.pipelines_type_not_declared)
        ends.forEach { node ->
            val prefix = node.id.takeIf { ends.size > 1 }
            if (prefix != null && node.output == null) {
                Item(title = node.id, subtitle = notDeclared, showChevron = false)
            } else {
                TypeItems(node.output, notDeclared, PipelineDefinitionTags.OUTPUT, prefix, schemaToggle = false)
            }
        }
        val schemas = ends.mapNotNull { node -> node.output?.let { node.id to it.json } }
        if (schemas.isNotEmpty()) SchemaToggle(if (ends.size == 1) schemas[0].second else JsonObject(schemas.toMap()), PipelineDefinitionTags.OUTPUT)
    }
}

/**
 * A type as rows: an object's fields each by name, its type (monospaced)
 * and Required or Optional on the right; any other type in one row; [empty]
 * where none is declared. [prefix] names whose fields they are. The JSON
 * Schema it was written as is a tap away.
 */
@Composable
internal fun TypeItems(type: PipelineType?, empty: String, tag: String, prefix: String? = null, schemaToggle: Boolean = true) {
    if (type == null) return NoteItem(empty)
    val schema = type.schema
    val name = { field: String -> if (prefix == null) field else "$prefix.$field" }
    when {
        schema is PipelineSchema.ObjectOf && schema.fields.isNotEmpty() -> schema.fields.forEach { field ->
            Item(
                title = name(field.name),
                subtitle = schemaText(field.schema),
                subtitleStyle = typeStyle,
                subtitleLines = 0,
                detail = stringResource(if (field.required) R.string.pipelines_field_required else R.string.pipelines_field_optional),
                showChevron = false,
                modifier = Modifier.testTag(PipelineDefinitionTags.field(tag, name(field.name))),
            )
        }
        schema is PipelineSchema.ObjectOf && !schema.nullable -> NoteItem(prefix?.let { stringResource(R.string.pipelines_type_no_fields_of, it) } ?: stringResource(R.string.pipelines_type_no_fields))
        else -> Item(title = prefix ?: stringResource(R.string.pipelines_type), subtitle = schemaText(schema), subtitleStyle = typeStyle, subtitleLines = 0, showChevron = false)
    }
    if (schemaToggle) SchemaToggle(type.json, tag)
}

/** "Show JSON Schema": the type as written, behind a tap. */
@Composable
private fun SchemaToggle(json: JsonElement, tag: String) {
    var shown by rememberSaveable(tag) { mutableStateOf(false) }
    Item(
        title = stringResource(if (shown) R.string.pipelines_schema_hide else R.string.pipelines_schema_show),
        titleColor = HappyTheme.colors.textLink,
        onClick = { shown = !shown },
        showChevron = false,
        modifier = Modifier.testTag(PipelineDefinitionTags.schemaToggle(tag)),
    )
    if (shown) {
        val text = remember(json) { prettyJson(json) }
        MonoBlock(text, Modifier.testTag(PipelineDefinitionTags.schema(tag)), top = 0.dp)
    }
}

/** A permission set as label and value, leaving out what it doesn't grant (desktop's `pipelinePermissionFacts`). */
internal fun permissionFacts(resources: Resources, permissions: PipelinePermissions, agents: AgentNames, pipelineName: (String) -> String): List<Pair<String, String>> {
    fun grants(entries: List<PipelineGrant>) = entries.joinToString(", ") {
        resources.getString(if (it.write) R.string.pipelines_grant_write else R.string.pipelines_grant_read, it.id)
    }
    val compute = permissions.compute
    return listOf(
        R.string.pipelines_grants_tools to permissions.tools.joinToString(", "),
        R.string.pipelines_grants_vaults to grants(permissions.vaults),
        R.string.pipelines_grants_secrets to permissions.secrets.joinToString(", "),
        R.string.pipelines_grants_repositories to grants(permissions.repositories),
        R.string.pipelines_grants_agents to permissions.agents.joinToString(", ") { agents.name(it) ?: it },
        R.string.pipelines_grants_pipelines to permissions.pipelines.joinToString(", ", transform = pipelineName),
        R.string.pipelines_grants_hosts to permissions.egressHosts.joinToString(", "),
        R.string.pipelines_grants_pools to compute?.pools.orEmpty().joinToString(", "),
        R.string.pipelines_grants_computers to compute?.computers.orEmpty().joinToString(", "),
        R.string.pipelines_grants_max_leases to (compute?.maxLeases?.toString() ?: ""),
    ).filter { it.second.isNotEmpty() }.map { (label, value) -> resources.getString(label) to value }
}

/** What a permission set grants, a row each, or [none] said plainly: the default is deny. */
@Composable
internal fun PermissionItems(permissions: PipelinePermissions?, none: String, agents: AgentNames, pipelineName: (String) -> String) {
    val facts = permissionFacts(LocalResources.current, permissions ?: PipelinePermissions(), agents, pipelineName)
    if (facts.isEmpty()) return NoteItem(none)
    facts.forEach { (label, value) -> Item(title = label, subtitle = value, subtitleLines = 0, showChevron = false) }
}

/** The computers a node holds (desktop's `computeFacts`): what it acquires and from where, uses, and hands on. */
@Composable
internal fun ComputeItems(compute: PipelineCompute?) {
    val facts = listOf(
        R.string.pipelines_compute_acquires to compute?.acquire.orEmpty().map {
            if (it.pool != null) stringResource(R.string.pipelines_compute_from_pool, it.name, it.pool) else stringResource(R.string.pipelines_compute_on_computer, it.name, it.computer.orEmpty())
        },
        R.string.pipelines_compute_uses to compute?.use.orEmpty(),
        R.string.pipelines_compute_passes to compute?.pass.orEmpty(),
    ).filter { it.second.isNotEmpty() }
    if (facts.isEmpty()) return NoteItem(stringResource(R.string.pipelines_compute_none))
    facts.forEach { (label, values) -> Item(title = stringResource(label), subtitle = values.joinToString(", "), subtitleLines = 0, showChevron = false) }
}
