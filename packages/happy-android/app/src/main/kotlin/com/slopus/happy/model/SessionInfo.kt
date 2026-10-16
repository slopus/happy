package com.slopus.happy.model

import com.slopus.happy.model.settings.Versions
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// What session/[id]/info.tsx reads out of a session: utils/resumeCommand.ts,
// utils/versionUtils.ts and the screen's own formatting helpers.

/** versionUtils.ts `MINIMUM_CLI_VERSION` */
const val MINIMUM_CLI_VERSION = "0.10.0"

/** info.tsx `isCliOutdated`: a CLI version below [MINIMUM_CLI_VERSION]. */
fun isCliOutdated(version: String?): Boolean = !version.isNullOrEmpty() && Versions.compare(version, MINIMUM_CLI_VERSION) < 0

/** resumeCommand.ts `ResumeCommandBlock` */
data class ResumeCommandBlock(val lines: List<String>, val copyText: String)

private fun SessionMetadata.isWindows() = os?.lowercase() == "win32"

/** resumeCommand.ts `buildResumeCommandBlock`: cd into the folder, then `happy claude|codex --resume`. */
fun SessionMetadata?.resumeCommandBlock(): ResumeCommandBlock? {
    if (this == null || client?.id == "rig" || (raw["capabilities"] as? JsonObject)?.get("resume") == JsonPrimitive(false)) return null
    val invocation = when {
        (flavor == "codex" || flavor == "openai" || flavor == "gpt") && !codexThreadId.isNullOrEmpty() -> "happy codex --resume $codexThreadId"
        !claudeSessionId.isNullOrEmpty() -> "happy claude --resume $claudeSessionId"
        else -> return null
    }
    val dir = path.trim().takeIf { it.isNotEmpty() }?.let {
        if (isWindows()) "Set-Location -LiteralPath '${path.replace("'", "''")}'" else "cd '${path.replace("'", "'\\''")}'"
    }
    val lines = listOfNotNull(dir, invocation)
    return ResumeCommandBlock(lines, lines.joinToString("\n"))
}

/** resumeCommand.ts `buildResumeCommand`: the block on one line. */
fun SessionMetadata?.resumeCommand(): String? {
    val block = resumeCommandBlock() ?: return null
    return block.lines.joinToString(if (this!!.isWindows()) "; " else " && ")
}

/** How a sandbox or permission setting reads (info.tsx). */
enum class InfoSetting { Enabled, Disabled, Unknown }

/** A sandbox summary: disabled, a free-form string, or enabled with its isolation, network and workspace. */
sealed interface SandboxSummary {
    data object Disabled : SandboxSummary
    data class Text(val text: String) : SandboxSummary
    data class Enabled(val isolation: String?, val network: String?, val workspace: String?) : SandboxSummary
}

/** info.tsx `formatSandboxMetadata` */
fun sandboxSummary(sandbox: JsonElement?, homeDir: String?): SandboxSummary {
    if (sandbox == null || sandbox is JsonNull) return SandboxSummary.Disabled
    if (sandbox is JsonPrimitive) return SandboxSummary.Text(sandbox.content)
    val value = sandbox as? JsonObject ?: return SandboxSummary.Text(sandbox.toString())
    if ((value["enabled"] as? JsonPrimitive)?.booleanOrNull == false) return SandboxSummary.Disabled
    fun string(key: String) = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return SandboxSummary.Enabled(
        isolation = string("sessionIsolation"),
        network = string("networkMode"),
        workspace = string("workspaceRoot")?.let { formatPathRelativeToHome(it, homeDir) },
    )
}

/** info.tsx `formatDangerouslySkipPermissionsMetadata`; this app keeps no per-session permission mode. */
fun dangerouslySkipPermissions(value: Boolean?, flavor: String?, sandbox: JsonElement?): InfoSetting = when {
    value != null -> if (value) InfoSetting.Enabled else InfoSetting.Disabled
    flavor == "claude" && ((sandbox as? JsonObject)?.get("enabled") as? JsonPrimitive)?.booleanOrNull == true -> InfoSetting.Enabled
    else -> InfoSetting.Unknown
}

/** info.tsx's AI provider row: Happy Agent's provider, else the flavor by name. */
fun SessionMetadata.aiProviderName(): String {
    rigIdentity()?.let { return it.providerName }
    return when (val flavor = flavor?.ifEmpty { null } ?: "claude") {
        "claude" -> "Claude"
        "gpt", "openai" -> "Codex"
        "gemini" -> "Gemini"
        "openclaw" -> "OpenClaw"
        else -> flavor
    }
}

/** `${id.substring(0, 8)}...${id.substring(id.length - 8)}` */
fun shortId(id: String): String = "${id.take(8)}...${id.takeLast(8)}"

/** sessionGitPresentation.ts as far as this app has git data: Happy Agent's published summary. */
data class SessionGitPresentation(val changedFileCount: Long?, val changes: VisibleGitChanges?)

fun SessionMetadata?.gitPresentation(): SessionGitPresentation {
    val git = rigGitSummary() ?: return SessionGitPresentation(null, null)
    val changes = if (git.insertions == 0L && git.deletions == 0L) null else VisibleGitChanges(!git.countsExact, git.insertions, git.deletions)
    return SessionGitPresentation(git.changedFiles, changes)
}
