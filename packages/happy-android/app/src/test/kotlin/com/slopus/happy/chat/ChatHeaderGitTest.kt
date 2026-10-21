package com.slopus.happy.chat

import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.VisibleGitChanges
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatHeaderGitTest {
    private fun metadata(extra: String = "") = SessionMetadata.parse("""{"path":"/p","host":"h"$extra}""")

    private fun status(branch: String?, added: Long, removed: Long, updatedAt: Long = 1) = GitStatus(
        branch = branch, isDirty = added + removed > 0, modifiedCount = 0, untrackedCount = 0, stagedCount = 0,
        lastUpdatedAt = updatedAt, stagedLinesAdded = 0, stagedLinesRemoved = 0, unstagedLinesAdded = added,
        unstagedLinesRemoved = removed, linesAdded = added, linesRemoved = removed, linesChanged = added + removed,
    )

    private val rig = ""","client":{"id":"rig","name":"Happy Agent","version":"1"},"rigMetadataVersion":1"""

    @Test
    fun theWorkspaceNameComesFirst() {
        val git = resolveChatHeaderGit(metadata(""","workspace":{"id":"w","kind":"worktree","name":"chat"},"gitBranch":"meta""""), status("live", 0, 0))
        assertEquals("chat", git.subtitle)
    }

    @Test
    fun theLiveBranchBeatsTheMetadataOne() {
        assertEquals("live", resolveChatHeaderGit(metadata(""","gitBranch":"meta""""), status("live", 0, 0)).subtitle)
        assertEquals("meta", resolveChatHeaderGit(metadata(""","gitBranch":"meta""""), status(null, 0, 0)).subtitle)
        assertEquals("meta", resolveChatHeaderGit(metadata(""","gitBranch":"meta""""), null).subtitle)
    }

    @Test
    fun liveCountsShowOnceRead() {
        assertEquals(VisibleGitChanges(false, 3, 1), resolveChatHeaderGit(metadata(), status("b", 3, 1)).changes)
        assertEquals(null, resolveChatHeaderGit(metadata(), status("b", 3, 1, updatedAt = 0)).changes)
        assertEquals(null, resolveChatHeaderGit(metadata(), status("b", 0, 0)).changes)
    }

    @Test
    fun aRigSummaryOverridesTheLiveStatus() {
        val inexact = metadata("$rig,\"git\":{\"changedFiles\":2,\"countsExact\":false,\"deletions\":4,\"insertions\":9}")
        assertEquals(VisibleGitChanges(true, 9, 4), resolveChatHeaderGit(inexact, status("b", 3, 1)).changes)
        val clean = metadata("$rig,\"git\":{\"changedFiles\":0,\"countsExact\":true,\"deletions\":0,\"insertions\":0}")
        assertEquals(null, resolveChatHeaderGit(clean, status("b", 3, 1)).changes)
    }
}
