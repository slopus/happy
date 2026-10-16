package com.slopus.happy.ui.troubleshoot

/**
 * One computer as troubleshoot lists it: Home's
 * [com.slopus.happy.model.MachineChoice], cut to what the screen reads. [happyHomeDir] is the Happy CLI machine's, else
 * the Happy Agent machine's (`metadata.happyHomeDir`).
 */
data class TroubleshootComputer(
    val id: String,
    val name: String,
    val machineIds: List<String> = listOf(id),
    val online: Boolean,
    val activeAt: Long,
    val happyHomeDir: String? = null,
)

/** A session, as far as troubleshooting reads it (`metadata.machineId`, `project.name`, `path`, `happyHomeDir`). */
data class TroubleshootSession(
    val updatedAt: Long,
    val machineId: String?,
    val projectName: String? = null,
    val path: String? = null,
    val happyHomeDir: String? = null,
)

data class OfflineMachineTroubleshooting(
    val machineName: String,
    val projectName: String,
    val happyHomeDir: String,
    val aiPrompt: String,
    val message: String,
)

private fun projectNameFromPath(path: String?): String? {
    val normalized = path?.trim()?.replace(Regex("[/\\\\]+$"), "")
    if (normalized.isNullOrEmpty()) return null
    return normalized.split(Regex("[/\\\\]")).last().ifEmpty { null }
}

/**
 * offlineMachineTroubleshooting.ts: the help shown when an account has
 * machines but none are reachable. The newest session on a known machine
 * picks the machine, so the AI prompt points at that machine's Happy logs.
 */
fun buildOfflineMachineTroubleshooting(
    choices: List<TroubleshootComputer>,
    sessions: List<TroubleshootSession>,
): OfflineMachineTroubleshooting {
    var choice = choices.sortedByDescending { it.activeAt }.firstOrNull()
    var session: TroubleshootSession? = null
    for (candidate in sessions.sortedByDescending { it.updatedAt }) {
        val candidateChoice = choices.firstOrNull { candidate.machineId.orEmpty() in it.machineIds } ?: continue
        choice = candidateChoice
        session = candidate
        break
    }

    val machineName = choice?.name?.trim()?.ifEmpty { null } ?: "this machine"
    val projectName = session?.projectName?.trim()?.ifEmpty { null }
        ?: projectNameFromPath(session?.path)
        ?: "Happy"
    val happyHomeDir = choice?.happyHomeDir?.trim()?.ifEmpty { null }
        ?: session?.happyHomeDir?.trim()?.ifEmpty { null }
        ?: "~/.happy"
    val aiPrompt = "In $happyHomeDir, diagnose why Happy cannot reach \"$machineName\" for project \"$projectName\"."
    return OfflineMachineTroubleshooting(
        machineName = machineName,
        projectName = projectName,
        happyHomeDir = happyHomeDir,
        aiPrompt = aiPrompt,
        message = listOf(
            "1. Wake the machine and check internet.",
            "2. Run `happy` again.",
            "3. Reopen Happy.",
            "",
            "AI prompt:",
            aiPrompt,
        ).joinToString("\n"),
    )
}
