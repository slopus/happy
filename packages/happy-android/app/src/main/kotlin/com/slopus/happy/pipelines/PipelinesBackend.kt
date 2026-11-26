package com.slopus.happy.pipelines

import com.slopus.happy.agent.AccountFeature
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.decode
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.long
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A Happy Cloud server's pipelines, read only: the screens see this, and a
 * debug fixture passes its own. Every read throws on failure.
 */
interface PipelinesBackend {
    /** `GET /v0/pipelines`, by name. */
    suspend fun pipelines(): List<PipelineSummary>

    /**
     * `GET /v0/pipeline-runs`: every run of the team, newest first, from
     * [cursor] (the newest page when null). Null where the server doesn't
     * list runs across pipelines (`404`).
     */
    suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry>?

    /** `GET /v0/pipeline-runs/:id`; null for a run the server doesn't have (`404`). */
    suspend fun run(runId: String): PipelineRun?

    /** `GET /v0/pipelines/:id`'s name; null for a pipeline archived or gone (`404`). */
    suspend fun pipelineName(pipelineId: String): String?

    /** `GET /v0/pipelines/:id` with its head version's definition; null for a pipeline archived or gone (`404`). */
    suspend fun pipeline(pipelineId: String): PipelineDetail?

    /** `GET /v0/pipelines/:id/versions`, newest first; null for a pipeline archived or gone (`404`). */
    suspend fun versions(pipelineId: String): List<PipelineVersion>?

    /** `GET /v0/pipelines/:id/versions/:number`; null for one the server doesn't have (`404`). */
    suspend fun version(pipelineId: String, number: Int): PipelineVersionDetail?

    /** A version's graph; null when it isn't one this app reads, or the server doesn't have it. */
    suspend fun definition(pipelineId: String, version: Int): PipelineDefinition? = version(pipelineId, version)?.definition

    /**
     * `GET /v0/pipelines/:id/runs`: the pipeline's runs, newest first, from
     * [cursor] (the newest page when null), archived pipelines' too; null for
     * a pipeline the server doesn't have (`404`).
     */
    suspend fun pipelineRuns(pipelineId: String, cursor: String?): PipelineRunPage<PipelineRunEntry>?

    /** `GET /v0/pipeline-runs/:id/nodes/:nodeId/log` after [after]; null where the node has no log yet (`404`). */
    suspend fun log(runId: String, nodeId: String, after: Long): PipelineLogPage?

    /** `POST /v0/pipeline-runs/:id/abort`. Idempotent: an ended run stays as it was. */
    suspend fun abort(runId: String)
}

/**
 * The person turned Pipelines off for their account: a route of theirs
 * answered `403 feature_not_installed`. Not a failure to show; the pages
 * leave.
 */
class PipelinesTurnedOff : Exception("Pipelines are turned off for this account")

/**
 * happy-cluster API.md, "Pipelines". The readers are desktop's
 * (`pipelineRead.ts`), checked against production answers: what isn't the
 * shape is left out rather than guessed at, a name the server leaves out is
 * the ID, and an agent trigger without its agent is still an agent's run.
 * A route refused because the person turned Pipelines off tells
 * [turnedOff] and throws [PipelinesTurnedOff].
 */
class ClusterPipelines(private val client: AgentClient, private val turnedOff: () -> Unit = {}) : PipelinesBackend {
    override suspend fun pipelines(): List<PipelineSummary> = call {
        summaries(client.decode<JsonObject>("GET", "/v0/pipelines")).sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    override suspend fun runs(cursor: String?): PipelineRunPage<PipelineRunListEntry>? = notFoundIsNull {
        runList(client.decode<JsonObject>("GET", RUNS + (cursor?.let { "?cursor=${AgentClient.escape(it)}" } ?: "")))
    }

    override suspend fun run(runId: String): PipelineRun? = notFoundIsNull {
        readRun(client.decode<JsonObject>("GET", "$RUNS/${AgentClient.escape(runId)}")) ?: throw IllegalStateException("A run this app can't read")
    }

    override suspend fun pipelineName(pipelineId: String): String? = notFoundIsNull {
        client.decode<JsonObject>("GET", "/v0/pipelines/${AgentClient.escape(pipelineId)}")["pipeline"].obj?.get("name").text()
    }

    override suspend fun pipeline(pipelineId: String): PipelineDetail? = notFoundIsNull {
        readPipeline(client.decode<JsonObject>("GET", "/v0/pipelines/${AgentClient.escape(pipelineId)}")) ?: throw IllegalStateException("A pipeline this app can't read")
    }

    override suspend fun versions(pipelineId: String): List<PipelineVersion>? = notFoundIsNull {
        readVersions(client.decode<JsonObject>("GET", "/v0/pipelines/${AgentClient.escape(pipelineId)}/versions"))
    }

    override suspend fun version(pipelineId: String, number: Int): PipelineVersionDetail? = notFoundIsNull {
        val version = client.decode<JsonObject>("GET", "/v0/pipelines/${AgentClient.escape(pipelineId)}/versions/$number")["version"]
        versionDetail(version) ?: throw IllegalStateException("A version this app can't read")
    }

    override suspend fun pipelineRuns(pipelineId: String, cursor: String?): PipelineRunPage<PipelineRunEntry>? = notFoundIsNull {
        val answer = client.decode<JsonObject>("GET", "/v0/pipelines/${AgentClient.escape(pipelineId)}/runs" + (cursor?.let { "?cursor=${AgentClient.escape(it)}" } ?: ""))
        PipelineRunPage(answer["runs"].arr.orEmpty().mapNotNull(::runEntry), answer["nextCursor"].text())
    }

    override suspend fun log(runId: String, nodeId: String, after: Long): PipelineLogPage? = notFoundIsNull {
        logPage(client.decode<JsonObject>("GET", "$RUNS/${AgentClient.escape(runId)}/nodes/${AgentClient.escape(nodeId)}/log?after=$after&limit=$LOG_LIMIT"), after)
    }

    override suspend fun abort(runId: String) = call {
        client.send("POST", "$RUNS/${AgentClient.escape(runId)}/abort")
        Unit
    }

    private inline fun <T> notFoundIsNull(read: () -> T): T? = call {
        try {
            read()
        } catch (e: AgentApiException) {
            if (e.status == 404) null else throw e
        }
    }

    private inline fun <T> call(request: () -> T): T = try {
        request()
    } catch (e: AgentApiException) {
        if (!AccountFeature.refusedAsOff(e, AccountFeature.PIPELINES)) throw e
        turnedOff()
        throw PipelinesTurnedOff()
    }

    internal companion object {
        const val RUNS = "/v0/pipeline-runs"

        /** Entries one log read asks for (desktop's). */
        const val LOG_LIMIT = 500

        private fun JsonElement?.text(): String? = str?.takeIf { it.isNotEmpty() }

        private fun runSummary(json: JsonElement?): PipelineRunSummary? {
            val run = json.obj ?: return null
            val id = run["id"].str ?: return null
            val state = PipelineRunState.of(run["state"].str) ?: return null
            return PipelineRunSummary(id, state, run["createdAt"].long ?: 0, run["endedAt"].long)
        }

        /** `{ pipelines: [...] }`; a pipeline without an ID or a head version is left out. */
        fun summaries(answer: JsonElement?): List<PipelineSummary> = answer.obj?.get("pipelines").arr.orEmpty().mapNotNull { element ->
            val pipeline = element.obj ?: return@mapNotNull null
            val id = pipeline["id"].str ?: return@mapNotNull null
            val head = pipeline["head"].obj?.get("number").num?.toInt() ?: return@mapNotNull null
            PipelineSummary(
                id = id,
                name = pipeline["name"].text() ?: id,
                description = pipeline["description"].text(),
                headVersion = head,
                enabled = pipeline["enabled"].bool != false,
                lastRun = runSummary(pipeline["lastRun"]),
            )
        }

        fun trigger(json: JsonElement?): PipelineRunTrigger? {
            val trigger = json.obj ?: return null
            return when (trigger["kind"].str) {
                // An agent the server no longer names (removed) is still an agent's run.
                "agent" -> PipelineRunTrigger.Agent(trigger["agentId"].text())
                "pipeline" -> {
                    val runId = trigger["runId"].str ?: return null
                    val nodeId = trigger["nodeId"].str ?: return null
                    PipelineRunTrigger.Pipeline(runId, nodeId)
                }
                else -> null
            }
        }

        fun runEntry(json: JsonElement?): PipelineRunEntry? {
            val run = json.obj ?: return null
            val id = run["id"].str ?: return null
            val state = PipelineRunState.of(run["state"].str) ?: return null
            val version = run["version"].num?.toInt() ?: return null
            return PipelineRunEntry(
                id = id,
                version = version,
                state = state,
                trigger = trigger(run["trigger"]),
                parentRunId = run["parentRunId"].text(),
                createdAt = run["createdAt"].long ?: 0,
                startedAt = run["startedAt"].long,
                endedAt = run["endedAt"].long,
            )
        }

        /** `{ runs: [...], nextCursor }` across pipelines, each entry with its `pipelineId`, `pipelineName` and `pipelineArchived`. */
        fun runList(answer: JsonElement?): PipelineRunPage<PipelineRunListEntry> {
            val page = answer.obj
            val runs = page?.get("runs").arr.orEmpty().mapNotNull { element ->
                val entry = runEntry(element) ?: return@mapNotNull null
                val json = element.obj ?: return@mapNotNull null
                val pipelineId = json["pipelineId"].str ?: return@mapNotNull null
                PipelineRunListEntry(entry, pipelineId, json["pipelineName"].text() ?: pipelineId, json["pipelineArchived"].bool == true)
            }
            return PipelineRunPage(runs, page?.get("nextCursor").text())
        }

        private fun count(json: JsonElement?): Long = json.long?.takeIf { it >= 0 } ?: 0

        private fun statusLine(json: JsonElement?): PipelineStatusLine? {
            val status = json.obj ?: return null
            val text = status["text"].str ?: return null
            return PipelineStatusLine(text, status["progress"].num?.toFloat()?.coerceIn(0f, 1f), status["at"].long ?: 0)
        }

        /** `{ [provider]: { [model]: { input, output, cacheRead, cacheWrite, reasoning, costUsd? } } }`, by provider then model; null when empty. */
        private fun usage(json: JsonElement?): List<PipelineModelUsage>? {
            val providers = json.obj ?: return null
            val usage = providers.flatMap { (provider, models) ->
                models.obj.orEmpty().mapNotNull { (model, spent) ->
                    val fields = spent.obj ?: return@mapNotNull null
                    PipelineModelUsage(
                        provider, model,
                        input = count(fields["input"]),
                        output = count(fields["output"]),
                        cacheRead = count(fields["cacheRead"]),
                        cacheWrite = count(fields["cacheWrite"]),
                        reasoning = count(fields["reasoning"]),
                        costUsd = fields["costUsd"].num?.takeIf { it >= 0 },
                    )
                }
            }.sortedWith(compareBy({ it.provider }, { it.model }))
            return usage.ifEmpty { null }
        }

        private fun JsonElement?.value(): JsonElement? = this?.takeUnless { it is JsonNull }

        private fun nodeRun(json: JsonElement?): PipelineNodeRun? {
            val node = json.obj ?: return null
            val nodeId = node["nodeId"].str ?: return null
            val kind = PipelineNodeKind.of(node["kind"].str) ?: return null
            val state = PipelineNodeState.of(node["state"].str) ?: return null
            val failure = node["failure"].obj
            return PipelineNodeRun(
                nodeId = nodeId,
                kind = kind,
                state = state,
                status = statusLine(node["status"]),
                statuses = node["statuses"].arr.orEmpty().mapNotNull(::statusLine),
                input = node["input"].value(),
                output = node["output"].value(),
                failure = failure?.get("code").str?.let { PipelineFailure(it, failure?.get("message").str.orEmpty()) },
                agentId = node["agentId"].text(),
                childRunId = node["childRunId"].text(),
                startedAt = node["startedAt"].long,
                endedAt = node["endedAt"].long,
                usage = usage(node["usage"]),
            )
        }

        private fun lease(json: JsonElement?): PipelineLease? {
            val lease = json.obj ?: return null
            val name = lease["name"].str ?: return null
            val computerId = lease["computerId"].str ?: return null
            return PipelineLease(name, computerId, lease["holders"].arr.orEmpty().mapNotNull { it.str }, lease["releasedAt"].long)
        }

        private fun texts(json: JsonElement?): List<String> = json.arr.orEmpty().mapNotNull { it.str }

        /** `{ run: Run }`; null when it isn't a run. */
        fun readRun(answer: JsonElement?): PipelineRun? {
            val run = answer.obj?.get("run").obj ?: return null
            val entry = runEntry(run) ?: return null
            val pipelineId = run["pipelineId"].str ?: return null
            return PipelineRun(
                entry = entry,
                pipelineId = pipelineId,
                rootRunId = run["rootRunId"].text() ?: entry.id,
                group = run["group"].text(),
                input = run["input"].value(),
                outputs = run["result"].obj?.let { it["outputs"].obj ?: JsonObject(emptyMap()) },
                nodes = run["nodes"].arr.orEmpty().mapNotNull(::nodeRun),
                leases = run["leases"].arr.orEmpty().mapNotNull(::lease),
                childRunIds = texts(run["childRunIds"]),
            )
        }

        private fun literal(json: JsonElement): JsonPrimitive? = (json as? JsonPrimitive)?.takeIf { it is JsonNull || it.isString || it.bool != null || it.num != null }

        /** A type in the definition's schema subset; null when it isn't one (desktop's `pipelineSchemaRead`). */
        fun schema(json: JsonElement?): PipelineSchema? {
            val schema = json.obj ?: return null
            val declared = schema["type"]
            val nullable: Boolean
            val type: String?
            if (declared is JsonArray) {
                if (declared.size != 2 || declared[1].str != "null") return null
                nullable = true
                type = declared[0].str
            } else {
                nullable = false
                type = declared.str
            }
            return when (type) {
                "null" -> PipelineSchema.Null
                "object" -> {
                    val required = texts(schema["required"]).toSet()
                    val fields = schema["properties"].obj.orEmpty().map { (name, property) -> PipelineField(name, schema(property) ?: return null, name in required) }
                    PipelineSchema.ObjectOf(fields, nullable)
                }
                "array" -> PipelineSchema.ListOf(schema(schema["items"]) ?: return null, nullable)
                "string", "number", "integer", "boolean" -> PipelineSchema.Scalar(type, schema["enum"].arr?.mapNotNull(::literal), nullable)
                else -> null
            }
        }

        /** Left out, it is null; written but unreadable, the whole definition is refused (`return null` from it). */
        private fun type(json: JsonElement?): Result<PipelineType?> {
            if (json == null) return Result.success(null)
            val schema = schema(json) ?: return Result.failure(IllegalStateException())
            return Result.success(PipelineType(schema, json))
        }

        private fun grants(json: JsonElement?): List<PipelineGrant> = json.arr.orEmpty().mapNotNull { element ->
            val grant = element.obj ?: return@mapNotNull null
            val id = grant["id"].str ?: return@mapNotNull null
            when (grant["access"].str) {
                "read" -> PipelineGrant(id, write = false)
                "write" -> PipelineGrant(id, write = true)
                else -> null
            }
        }

        fun permissions(json: JsonElement?): PipelinePermissions {
            val permissions = json.obj ?: return PipelinePermissions()
            val compute = permissions["compute"].obj
            return PipelinePermissions(
                tools = texts(permissions["tools"]),
                vaults = grants(permissions["vaults"]),
                secrets = texts(permissions["secrets"]),
                repositories = grants(permissions["repositories"]),
                agents = texts(permissions["agents"]),
                pipelines = texts(permissions["pipelines"]),
                egressHosts = texts(permissions["egress"].obj?.get("hosts")),
                compute = compute?.let { PipelineComputeGrant(texts(it["pools"]), texts(it["computers"]), it["maxLeases"].num?.toInt()) },
            )
        }

        private fun compute(json: JsonElement?): PipelineCompute? {
            val compute = json.obj ?: return null
            val acquire = compute["acquire"].arr.orEmpty().mapNotNull { element ->
                val lease = element.obj ?: return@mapNotNull null
                val name = lease["name"].str ?: return@mapNotNull null
                val pool = lease["pool"].str
                val computer = lease["computer"].str
                if (pool == null && computer == null) null else PipelineAcquire(name, pool, computer.takeIf { pool == null })
            }
            return PipelineCompute(acquire, texts(compute["use"]), texts(compute["pass"]))
        }

        private fun nodeDefinition(id: String, json: JsonElement?): PipelineNodeDefinition? {
            val node = json.obj ?: return null
            val kind = PipelineNodeKind.of(node["kind"].str) ?: return null
            val pipelineId = node["pipeline"].str
            if (kind == PipelineNodeKind.Pipeline && pipelineId == null) return null
            val input = type(node["input"]).getOrElse { return null }
            val output = type(node["output"]).getOrElse { return null }
            val agent = kind == PipelineNodeKind.Agent
            return PipelineNodeDefinition(
                id = id,
                kind = kind,
                model = node["model"].text().takeIf { agent },
                pipelineId = pipelineId.takeIf { kind == PipelineNodeKind.Pipeline },
                effort = node["effort"].text().takeIf { agent },
                input = input,
                output = output,
                permissions = node["permissions"]?.let(::permissions),
                compute = compute(node["compute"]),
                timeoutSeconds = node["timeoutSeconds"].long ?: PipelineNodeDefinition.DEFAULT_TIMEOUT_SECONDS,
                joinAny = node["join"].str == "any",
                source = node["source"].str.takeIf { kind == PipelineNodeKind.Code },
                instructions = node["instructions"].str.takeIf { agent },
            )
        }

        /**
         * A version's `definition`. The cluster stores none that doesn't
         * validate, so a node, edge or type this app can't read is a contract
         * it doesn't know yet, and the whole definition is refused rather
         * than half read (desktop's `pipelineDefinitionRead`).
         */
        fun readDefinition(json: JsonElement?): PipelineDefinition? {
            val definition = json.obj ?: return null
            val root = definition["root"].str ?: return null
            val nodes = definition["nodes"].obj?.map { (id, node) -> nodeDefinition(id, node) ?: return null } ?: return null
            if (nodes.none { it.id == root }) return null
            val ids = nodes.mapTo(HashSet()) { it.id }
            val edges = definition["edges"].arr.orEmpty().map { element ->
                val edge = element.obj ?: return null
                val from = edge["from"].str?.takeIf { it in ids } ?: return null
                val to = edge["to"].str?.takeIf { it in ids } ?: return null
                when (edge["on"].str) {
                    "success" -> PipelineEdge(from, to, onSuccess = true)
                    "failure" -> PipelineEdge(from, to, onSuccess = false)
                    else -> return null
                }
            }
            val concurrency = definition["concurrency"].obj
            return PipelineDefinition(
                root = root,
                nodes = nodes,
                edges = edges,
                input = type(definition["input"]).getOrElse { return null },
                concurrency = PipelineConcurrency(
                    mode = when (concurrency?.get("mode").str) {
                        "supersede" -> PipelineConcurrencyMode.Supersede
                        "queue" -> PipelineConcurrencyMode.Queue
                        else -> PipelineConcurrencyMode.Independent
                    },
                    group = concurrency?.get("group").text(),
                    batch = concurrency?.get("batch").bool == true,
                ),
                triggerAgents = texts(definition["triggers"].obj?.get("agents")),
                permissions = permissions(definition["permissions"]),
            )
        }

        private fun author(json: JsonElement?): PipelineAuthor? {
            val author = json.obj ?: return null
            return when (author["kind"].str) {
                "user" -> author["userId"].text()?.let { PipelineAuthor(it, null) }
                "agent" -> author["agentId"].text()?.let { PipelineAuthor(author["userId"].text(), it) }
                else -> null
            }
        }

        fun version(json: JsonElement?): PipelineVersion? {
            val version = json.obj ?: return null
            val number = version["number"].num?.toInt() ?: return null
            return PipelineVersion(number, version["message"].str.orEmpty(), author(version["author"]), version["createdAt"].long ?: 0)
        }

        /** A version with its `definition`; null when the version itself isn't one. */
        fun versionDetail(json: JsonElement?): PipelineVersionDetail? {
            val version = version(json) ?: return null
            return PipelineVersionDetail(version, readDefinition(json.obj?.get("definition")))
        }

        /** `{ pipeline }`, its `head` the whole head version. */
        fun readPipeline(answer: JsonElement?): PipelineDetail? {
            val pipeline = answer.obj?.get("pipeline").obj ?: return null
            val id = pipeline["id"].str ?: return null
            val head = versionDetail(pipeline["head"]) ?: return null
            return PipelineDetail(id, pipeline["name"].text() ?: id, pipeline["description"].text(), pipeline["enabled"].bool != false, head)
        }

        /** `{ versions }`, newest first. */
        fun readVersions(answer: JsonElement?): List<PipelineVersion> =
            answer.obj?.get("versions").arr.orEmpty().mapNotNull(::version).sortedByDescending { it.number }

        private fun logEntry(json: JsonElement?): PipelineLogEntry? {
            val entry = json.obj ?: return null
            val seq = entry["seq"].long ?: return null
            val at = entry["at"].long ?: 0
            val text = entry["text"].str.orEmpty()
            return when (entry["kind"].str) {
                "output" -> PipelineLogEntry.Output(seq, at, stderr = entry["stream"].str == "stderr", text = text)
                "message" -> PipelineLogEntry.Message(seq, at, text)
                "status" -> PipelineLogEntry.Status(seq, at, text, entry["progress"].num?.toFloat()?.coerceIn(0f, 1f))
                "command" -> {
                    val state = when (entry["state"].str) {
                        "running" -> PipelineLogEntry.CommandState.Running
                        "exited" -> PipelineLogEntry.CommandState.Exited
                        "aborted" -> PipelineLogEntry.CommandState.Aborted
                        else -> return null
                    }
                    PipelineLogEntry.Command(
                        seq, at,
                        id = entry["id"].str ?: return null,
                        command = entry["command"].str ?: return null,
                        cwd = entry["cwd"].text(),
                        lease = entry["lease"].text(),
                        state = state,
                        exitCode = entry["exitCode"].num?.toInt(),
                        durationMs = entry["durationMs"].long,
                        output = entry["output"].str.orEmpty(),
                        outputTruncated = entry["outputTruncated"].bool == true,
                    )
                }
                "tool" -> {
                    val state = when (entry["state"].str) {
                        "running" -> PipelineLogEntry.ToolState.Running
                        "ok" -> PipelineLogEntry.ToolState.Ok
                        "error" -> PipelineLogEntry.ToolState.Error
                        else -> return null
                    }
                    PipelineLogEntry.Tool(
                        seq, at,
                        id = entry["id"].str ?: return null,
                        name = entry["name"].str ?: return null,
                        summary = entry["summary"].str.orEmpty(),
                        state = state,
                        durationMs = entry["durationMs"].long,
                        error = entry["error"].text(),
                    )
                }
                // A kind this app doesn't know yet is left out rather than guessed at.
                else -> null
            }
        }

        /** `{ entries, nextAfter, dropped, changed }`, read after [after]. */
        fun logPage(answer: JsonElement?, after: Long): PipelineLogPage {
            val page = answer.obj
            val entries = page?.get("entries").arr.orEmpty().mapNotNull(::logEntry)
            return PipelineLogPage(
                entries = entries,
                nextAfter = page?.get("nextAfter").long ?: entries.lastOrNull()?.seq ?: after,
                dropped = page?.get("dropped").long?.toInt() ?: 0,
                changed = page?.get("changed").arr.orEmpty().mapNotNull(::logEntry),
            )
        }
    }
}
