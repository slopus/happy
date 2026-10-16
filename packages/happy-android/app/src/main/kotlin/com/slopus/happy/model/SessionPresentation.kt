package com.slopus.happy.model

import com.slopus.happy.sync.ForkSource

// How a session is named and placed, from happy-app's utils/sessionUtils.ts,
// utils/sessionActivity.ts, utils/worktreePaths.ts and utils/sessionFork.ts.
// Everything here is plain arithmetic over stored fields; strings that come
// from the translation table are left to the caller (null = the fallback).

/**
 * getSessionName: the bot's name, else the summary, else null, which the
 * screens show as "New chat" (`session.newChat`).
 */
fun Session.displayName(): String? = metadata?.bot?.name ?: metadata?.summary?.text

/** getSessionSubtitle: the path relative to home, or null ("unknown"). */
fun Session.displaySubtitle(): String? = metadata?.let { formatPathRelativeToHome(it.path, it.homeDir) }

/**
 * getSessionAvatarId: deterministic per machine and path (or bot), so the
 * same place always gets the same generated avatar.
 */
fun Session.avatarId(): String {
    val metadata = metadata
    if (metadata?.bot != null) return "${metadata.machineId ?: ""}:bot:${metadata.bot.id}"
    val machineId = metadata?.machineId
    if (metadata != null && !machineId.isNullOrEmpty() && metadata.path.isNotEmpty()) return "$machineId:${metadata.path}"
    return id
}

/**
 * getSessionActivityAt: what the list sorts on. The agent's published
 * last-meaningful-message time, else this device's last send, else creation.
 */
fun Session.activityAt(): Long = metadata?.lastMeaningfulMessageAt ?: lastMessageSentAt ?: createdAt

/** formatPathRelativeToHome: `~` for the home directory and what is under it. */
fun formatPathRelativeToHome(path: String, homeDir: String?): String {
    if (homeDir.isNullOrEmpty()) return path
    val normalizedHome = if (homeDir.endsWith("/")) homeDir.dropLast(1) else homeDir
    if (!path.startsWith(normalizedHome)) return path
    val relative = path.substring(normalizedHome.length)
    return when {
        relative.startsWith("/") -> "~$relative"
        relative.isEmpty() -> "~"
        else -> "~/$relative"
    }
}

/** formatOSPlatform */
fun formatOSPlatform(platform: String?): String {
    if (platform.isNullOrEmpty()) return ""
    return when (platform.lowercase()) {
        "darwin" -> "macOS"
        "win32" -> "Windows"
        "linux" -> "Linux"
        "android" -> "Android"
        "ios" -> "iOS"
        "aix" -> "AIX"
        "freebsd" -> "FreeBSD"
        "openbsd" -> "OpenBSD"
        "sunos" -> "SunOS"
        else -> platform
    }
}

/** utils/worktreePaths.ts: where Happy creates git worktrees inside a repo. */
object WorktreePaths {
    const val DIR = ".dev/worktree"
    const val MARKER = "/$DIR/"

    fun isWorktree(path: String): Boolean = path.contains(MARKER)

    fun repoPath(path: String): String {
        val index = path.indexOf(MARKER)
        return if (index == -1) path else path.substring(0, index)
    }

    fun worktreeName(path: String): String? {
        val index = path.indexOf(MARKER)
        return if (index == -1) null else path.substring(index + MARKER.length)
    }
}

/** sessionFork.ts `getSessionForkSource` */
fun Session.forkSource(): ForkSource? {
    val machineId = metadata?.machineId?.takeIf { it.isNotBlank() } ?: return null
    val directory = metadata.path.takeIf { it.isNotBlank() } ?: return null
    if (metadata.flavor == "codex") {
        val thread = metadata.codexThreadId?.takeIf { it.isNotBlank() } ?: return null
        return ForkSource.Codex(id, machineId, directory, thread)
    }
    val claude = metadata.claudeSessionId?.takeIf { it.isNotBlank() } ?: return null
    return ForkSource.Claude(id, machineId, directory, claude)
}

/** projectTypes.ts `getSessionProjectId`: top-level linkage on current servers, metadata on older Rig. */
fun Session.projectIdOrNull(): String? =
    projectId?.trim()?.takeIf { it.isNotEmpty() } ?: metadata?.project?.id?.trim()?.takeIf { it.isNotEmpty() }

/** projectTypes.ts `isHappyAgentSession`: only Rig sessions may use private project artwork. */
fun Session.isHappyAgent(): Boolean = metadata?.client?.id == "rig"

/** resolveSessionAvatar.ts: the session's own image, else (Happy Agent only) its project's. */
fun Session.resolveAvatar(projects: Map<String, Project>): ProjectAvatar? {
    if (!avatar?.uri.isNullOrEmpty()) return avatar
    val projectId = projectIdOrNull()
    return if (isHappyAgent() && projectId != null) projects[projectId]?.avatar else null
}

/** sessionIdentity.ts: sessions are keyed by their Happy id alone; machine and account may be shared by several daemons. */
fun <T> indexSessionsById(sessions: Iterable<T>, id: (T) -> String): Map<String, T> =
    LinkedHashMap<String, T>().apply { sessions.forEach { put(id(it), it) } }

/** utils/avatarHarness.ts: which harness badge a session avatar carries. */
enum class AvatarHarness { Claude, Codex, Agy, Rig }

fun resolveAvatarHarness(flavor: String?, clientId: String?): AvatarHarness? {
    if (clientId == "rig") return AvatarHarness.Rig
    return when (flavor) {
        "claude" -> AvatarHarness.Claude
        "codex" -> AvatarHarness.Codex
        "agy" -> AvatarHarness.Agy
        else -> null
    }
}
