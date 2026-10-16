package com.slopus.happy.ui.home

import com.slopus.happy.model.GitWorktree
import com.slopus.happy.model.WorktreePaths
import com.slopus.happy.sync.BashResult
import kotlin.random.Random

sealed interface WorktreeOutcome {
    data class Created(val path: String, val branch: String) : WorktreeOutcome
    data class Failed(val message: String) : WorktreeOutcome
}

private val adjectives = listOf(
    "clever", "happy", "swift", "bright", "calm", "bold", "quiet", "brave", "wise", "eager",
    "gentle", "quick", "sharp", "smooth", "fresh",
)
private val nouns = listOf(
    "ocean", "forest", "cloud", "star", "river", "mountain", "valley", "bridge", "beacon", "harbor",
    "garden", "meadow", "canyon", "island", "desert",
)

/**
 * utils/worktree.ts createWorktree: a new `adjective-noun` branch checked
 * out under `.dev/worktree/` of [basePath], through the daemon's shell
 * ([bash] runs a command in [basePath]). A taken name is retried as
 * `-2` to `-4`. A failed shell call (exit -1) is reported as itself, not
 * as "Not a Git repository".
 */
suspend fun createWorktree(basePath: String, random: Random = Random, bash: suspend (command: String) -> BashResult): WorktreeOutcome {
    val name = "${adjectives.random(random)}-${nouns.random(random)}"
    val check = bash("git rev-parse --git-dir")
    if (!check.success) {
        return WorktreeOutcome.Failed(
            if (check.exitCode == -1) check.stderr.ifEmpty { "Failed to connect to machine" } else "Not a Git repository",
        )
    }
    suspend fun add(branch: String): BashResult = bash("git worktree add -b $branch ${WorktreePaths.DIR}/$branch")
    var result = add(name)
    if (result.success) return WorktreeOutcome.Created("$basePath/${WorktreePaths.DIR}/$name", name)
    if (result.stderr.contains("already exists")) {
        for (suffix in 2..4) {
            val branch = "$name-$suffix"
            result = add(branch)
            if (result.success) return WorktreeOutcome.Created("$basePath/${WorktreePaths.DIR}/$branch", branch)
        }
    }
    return WorktreeOutcome.Failed(result.stderr.ifEmpty { "Failed to create worktree" })
}

/**
 * utils/worktree.ts listWorktrees: `git worktree list --porcelain` in
 * [basePath], the main checkout left out. A worktree without a branch is
 * named by its path; any failure is no worktrees.
 */
suspend fun listWorktrees(bash: suspend (command: String) -> BashResult): List<GitWorktree> {
    val result = bash("git worktree list --porcelain")
    if (!result.success) return emptyList()
    return result.stdout.split("\n\n").drop(1).mapNotNull { block ->
        var path = ""
        var branch = ""
        for (line in block.split("\n")) {
            when {
                line.startsWith("worktree ") -> path = line.removePrefix("worktree ")
                line.startsWith("branch refs/heads/") -> branch = line.removePrefix("branch refs/heads/")
            }
        }
        path.takeIf { it.isNotEmpty() }?.let { GitWorktree(it, branch.ifEmpty { it }) }
    }
}
