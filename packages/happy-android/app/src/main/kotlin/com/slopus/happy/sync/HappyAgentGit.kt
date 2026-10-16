package com.slopus.happy.sync

import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.isRigV1
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64

/** happyAgentGit.ts `HappyAgentGitState.facts`. */
data class GitFacts(
    val branch: String?,
    val detached: Boolean,
    val head: String?,
    val upstream: String?,
    val ahead: Long,
    val behind: Long,
)

/** One changed file (happyAgentGit.ts `HappyAgentGitFile`). */
data class GitFile(
    val path: String,
    val previousPath: String? = null,
    /** added, conflicted, copied, deleted, modified, renamed, submodule, type_changed or untracked. */
    val status: String,
    val staged: Boolean,
    val unstaged: Boolean,
    val binary: Boolean,
    val insertions: Long? = null,
    val deletions: Long? = null,
)

/** A Happy Agent workspace's Git snapshot (happyAgentGit.ts `HappyAgentGitState`). */
data class GitState(
    val facts: GitFacts,
    /** `ready` (with a [base]) or `unavailable`. */
    val comparison: String,
    val base: String?,
    val changedFiles: Long,
    val insertions: Long,
    val deletions: Long,
    val countsExact: Boolean,
    val conflicted: Boolean,
    val files: List<GitFile>,
    val filesTruncated: Boolean,
    val scannedAt: Double,
)

/** The two sides of one changed file, ready to show (happyAgentGit.ts `HappyAgentFileContent`). */
sealed interface GitFileContent {
    data class Text(val oldText: String, val newText: String) : GitFileContent

    /** `data:` URIs; a side that does not exist is null. */
    data class Image(val before: String?, val after: String?) : GitFileContent

    /** Why this file is not shown. */
    data class Message(val message: String) : GitFileContent
}

/**
 * Happy Agent's native Git changes surface (happyAgentGit.ts): a validated
 * snapshot and both sides of a file, through session RPCs. Anything the
 * agent answers outside the schema is refused rather than half-shown.
 */
class HappyAgentGit internal constructor(
    private val rpc: RpcClient,
    private val store: HappyStore,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    /** happyAgentGit.ts `getHappyAgentGitState`. */
    suspend fun state(sessionId: String): GitState {
        requireSupported(sessionId)
        // The agent resolves its workspace from the session itself.
        val response = rpc.sessionRpc(sessionId, "gitState", JsonObject(emptyMap())) as? JsonObject
            ?: throw RpcException(INVALID_STATE)
        failure(response)?.let { throw RpcException(it) }
        if (response["success"] != JsonPrimitive(true)) throw RpcException(INVALID_STATE)
        return parseState(response["git"]) ?: throw RpcException(INVALID_STATE)
    }

    /** happyAgentGit.ts `readHappyAgentGitFile`: the base side at [gitBase], the other from the working tree. */
    suspend fun readFile(sessionId: String, gitBase: String, file: GitFile): GitFileContent {
        requireSupported(sessionId)
        if (!validFile(file)) throw RpcException("Happy Agent returned an invalid Git file.")
        if (!REVISION.matches(gitBase)) throw RpcException("Happy Agent returned an invalid Git comparison base.")
        unsupportedMessage(file)?.let { return GitFileContent.Message(it) }

        val beforePath = if (file.status == "added" || file.status == "untracked") null else file.previousPath ?: file.path
        val afterPath = if (file.status == "deleted") null else file.path
        if (beforePath == null && afterPath == null) return GitFileContent.Message("This file has no readable comparison side.")

        if (file.binary) {
            val nonImage = (beforePath != null && imageMimeType(beforePath) == null) ||
                (afterPath != null && imageMimeType(afterPath) == null)
            if (nonImage) return GitFileContent.Message(BINARY)
        }

        // Both sides start together, and both settle before either failure is reported.
        val (before, after) = supervisorScope {
            val before = async { beforePath?.let { readSide(sessionId, it, gitBase) } }
            val after = async { afterPath?.let { readSide(sessionId, it, null) } }
            val results = listOf(settle { before.await() }, settle { after.await() })
            results[0].getOrThrow() to results[1].getOrThrow()
        }

        return withContext(io) {
            if (file.binary) images(beforePath, before, afterPath, after) else text(before, after)
        }
    }

    private suspend fun requireSupported(sessionId: String) {
        val metadata = withContext(io) { SessionMetadata.parse(store.session(sessionId)?.metadataJson) }
        if (!supportsHappyAgentGit(metadata)) throw RpcException("Git changes are not available for this session.")
    }

    private suspend fun readSide(sessionId: String, path: String, revision: String?): String {
        val response = if (revision == null) {
            rpc.sessionRpc(sessionId, "readFile", buildJsonObject { put("path", path) })
        } else {
            rpc.sessionRpc(sessionId, "readFileAtRevision", buildJsonObject {
                put("path", path)
                put("revision", revision)
            })
        } as? JsonObject ?: throw RpcException(INVALID_FILE)
        failure(response)?.let { throw RpcException(it) }
        val content = response.string("content")
        val valid = response["success"] == JsonPrimitive(true) && content != null &&
            (revision != null || response.string("hash")?.let(HASH::matches) == true)
        if (!valid) throw RpcException(INVALID_FILE)
        return content
    }

    private fun images(beforePath: String?, before: String?, afterPath: String?, after: String?): GitFileContent {
        val uris = arrayOfNulls<String>(2)
        for ((index, side) in listOf(beforePath to before, afterPath to after).withIndex()) {
            val (path, content) = side
            if (path == null || content == null) continue
            val inspected = inspectBase64(content) ?: throw RpcException(INVALID_CONTENTS)
            if (inspected.decodedBytes > MAX_BYTES) throw RpcException(TOO_LARGE)
            if (inspected.decodedBytes == 0) return GitFileContent.Message("Image content is empty.")
            val mime = imageMimeType(path) ?: return GitFileContent.Message(BINARY)
            uris[index] = "data:$mime;base64,${inspected.normalized}"
        }
        return GitFileContent.Image(uris[0], uris[1])
    }

    private fun text(before: String?, after: String?): GitFileContent {
        val old = if (before == null) Base64Size("", 0) else inspectBase64(before)
        val new = if (after == null) Base64Size("", 0) else inspectBase64(after)
        if (old == null || new == null) throw RpcException(INVALID_CONTENTS)
        if (old.decodedBytes > MAX_BYTES || new.decodedBytes > MAX_BYTES) throw RpcException(TOO_LARGE)
        val oldText = decodeUtf8(old).getOrElse { return GitFileContent.Message(it.message!!) }
        val newText = decodeUtf8(new).getOrElse { return GitFileContent.Message(it.message!!) }
        val oldLines = countLinesWithin(oldText, MAX_TEXT_LINES)
        if (oldLines == null || countLinesWithin(newText, MAX_TEXT_LINES - oldLines) == null) {
            return GitFileContent.Message("This file has too many lines to preview here.")
        }
        return GitFileContent.Text(oldText, newText)
    }

    private class Base64Size(val normalized: String, val decodedBytes: Int)

    companion object {
        private val METHODS = listOf("gitState", "readFile", "readFileAtRevision")
        private val REVISION = Regex("^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
        private val HASH = Regex("^[0-9a-f]{64}$")
        private val STATUSES = setOf(
            "added", "conflicted", "copied", "deleted", "modified", "renamed", "submodule", "type_changed", "untracked",
        )
        private val FAILURE_CODES = setOf("invalid", "forbidden", "missing", "too_large", "unavailable", "unsupported")
        private val IMAGE_MIME_TYPES = mapOf(
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "bmp" to "image/bmp",
        )
        private const val MAX_BYTES = 512 * 1024
        private const val MAX_TEXT_LINES = 20_000
        private const val INVALID_STATE = "Happy Agent returned an invalid Git state."
        private const val INVALID_FILE = "Happy Agent returned an invalid file response."
        private const val INVALID_CONTENTS = "Happy Agent returned invalid file contents."
        private const val TOO_LARGE = "This file is too large to preview on the phone."
        private const val BINARY = "Binary file changes cannot be previewed."

        /** happyAgentGit.ts `supportsHappyAgentGit`: native v1, readable files, and every Git RPC advertised. */
        fun supportsHappyAgentGit(metadata: SessionMetadata?): Boolean {
            if (!metadata.isRigV1()) return false
            val capabilities = metadata?.capabilities ?: return false
            return capabilities.filesRead && METHODS.all { it in capabilities.rpcMethods }
        }

        /** imageFiles.ts `imageMimeType`: formats worth showing as a picture. SVG is text and diffs as text. */
        fun imageMimeType(path: String): String? {
            val dot = path.lastIndexOf('.')
            if (dot == -1) return null
            return IMAGE_MIME_TYPES[path.substring(dot + 1).lowercase()]
        }

        private inline fun <T> settle(block: () -> T): Result<T> = try {
            Result.success(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }

        /** A well-formed native failure's message, or null when [response] is not one. */
        private fun failure(response: JsonObject): String? {
            if (response["success"] != JsonPrimitive(false)) return null
            val error = response.string("error")?.takeIf { it.isNotEmpty() }
            return error.takeIf { response.string("code") in FAILURE_CODES }
        }

        private fun unsupportedMessage(file: GitFile): String? = when (file.status) {
            "conflicted" -> "This file has unresolved conflicts and cannot be previewed."
            "submodule" -> "Submodule changes cannot be previewed."
            "type_changed" -> "This file changed type and cannot be previewed."
            else -> null
        }

        private fun validFile(file: GitFile) = file.path.isNotEmpty() && file.previousPath?.isEmpty() != true &&
            file.status in STATUSES && (file.insertions ?: 0) >= 0 && (file.deletions ?: 0) >= 0

        internal fun parseState(element: JsonElement?): GitState? {
            val git = element as? JsonObject ?: return null
            val facts = git["facts"] as? JsonObject ?: return null
            val comparison = git.string("comparison")?.takeIf { it == "ready" || it == "unavailable" } ?: return null
            val base = git.nullableString("base") ?: return null
            if (base.value != null && !REVISION.matches(base.value)) return null
            if (comparison == "ready" && base.value == null) return null
            val files = (git["files"] as? JsonArray ?: return null).map { parseFile(it) ?: return null }
            val branch = facts.nullableString("branch") ?: return null
            val head = facts.nullableString("head") ?: return null
            val upstream = facts.nullableString("upstream") ?: return null
            return GitState(
                facts = GitFacts(
                    branch = branch.value,
                    detached = facts.boolean("detached") ?: return null,
                    head = head.value,
                    upstream = upstream.value,
                    ahead = facts.count("ahead") ?: return null,
                    behind = facts.count("behind") ?: return null,
                ),
                comparison = comparison,
                base = base.value,
                changedFiles = git.count("changedFiles") ?: return null,
                insertions = git.count("insertions") ?: return null,
                deletions = git.count("deletions") ?: return null,
                countsExact = git.boolean("countsExact") ?: return null,
                conflicted = git.boolean("conflicted") ?: return null,
                files = files,
                filesTruncated = git.boolean("filesTruncated") ?: return null,
                scannedAt = (git["scannedAt"] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
                    ?.takeIf { it.isFinite() && it >= 0 } ?: return null,
            )
        }

        private fun parseFile(element: JsonElement): GitFile? {
            val o = element as? JsonObject ?: return null
            val file = GitFile(
                path = o.string("path") ?: return null,
                previousPath = if (o.containsKey("previousPath")) o.string("previousPath") ?: return null else null,
                status = o.string("status") ?: return null,
                staged = o.boolean("staged") ?: return null,
                unstaged = o.boolean("unstaged") ?: return null,
                binary = o.boolean("binary") ?: return null,
                insertions = if (o.containsKey("insertions")) o.count("insertions") ?: return null else null,
                deletions = if (o.containsKey("deletions")) o.count("deletions") ?: return null else null,
            )
            return file.takeIf(::validFile)
        }

        /** A present string-or-null field; null when absent or another type. */
        private class Nullable(val value: String?)

        private fun JsonObject.nullableString(key: String): Nullable? = when (val value = this[key]) {
            is JsonNull -> Nullable(null)
            is JsonPrimitive -> if (value.isString) Nullable(value.content) else null
            else -> null
        }

        private fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

        /** z.number().int().nonnegative() */
        private fun JsonObject.count(key: String): Long? {
            val number = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull ?: return null
            return if (number >= 0 && number == Math.floor(number) && number <= Long.MAX_VALUE) number.toLong() else null
        }

        /** happyAgentGit.ts `inspectBase64`: whitespace dropped, unpadded final quartets accepted. */
        private fun inspectBase64(value: String): Base64Size? {
            val clean = value.replace(Regex("\\s+"), "")
            if (clean.isNotEmpty()) {
                if (!Regex("^[A-Za-z0-9+/]*={0,2}$").matches(clean)) return null
                val padding = clean.length - clean.trimEnd('=').length
                if (padding > 0 && clean.length % 4 != 0) return null
                if (clean.length % 4 == 1) return null
            }
            val normalized = clean + "=".repeat((4 - clean.length % 4) % 4)
            val padding = normalized.length - normalized.trimEnd('=').length
            return Base64Size(normalized, normalized.length / 4 * 3 - padding)
        }

        /** Strict UTF-8 that keeps a leading byte order mark, so adding or removing one shows as a change. */
        private fun decodeUtf8(inspected: Base64Size): Result<String> {
            val bytes = try {
                Base64.getDecoder().decode(inspected.normalized)
            } catch (_: IllegalArgumentException) {
                return Result.failure(IllegalStateException("This file is not valid UTF-8 text."))
            }
            val text = try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString()
            } catch (_: CharacterCodingException) {
                return Result.failure(IllegalStateException("This file is not valid UTF-8 text."))
            }
            if ('\u0000' in text) return Result.failure(IllegalStateException("This file contains binary data and cannot be shown as text."))
            return Result.success(text)
        }

        /** Real lines only: a final newline ends the last line rather than starting another. */
        private fun countLinesWithin(text: String, maximum: Int): Int? {
            if (text.isEmpty()) return 0
            if (maximum < 1) return null
            var lines = 1
            for (index in 0 until text.length - 1) {
                if (text[index] != '\n') continue
                lines += 1
                if (lines > maximum) return null
            }
            return lines
        }
    }
}
