package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.VisibleGitChanges
import com.slopus.happy.model.rigGitSummary

/** sessionGitPresentation.ts as the chat header reads it: the subtitle and the +/− counts. */
@Immutable
data class ChatHeaderGit(val subtitle: String?, val changes: VisibleGitChanges?)

/**
 * sessionGitPresentation.ts `resolveSessionGitPresentation` (no file list):
 * the workspace's name, else the live branch, else the metadata's. Happy
 * Agent's published summary gives the counts; otherwise a live status
 * (one that has been read at least once) does.
 */
fun resolveChatHeaderGit(metadata: SessionMetadata?, gitStatus: GitStatus?): ChatHeaderGit {
    val subtitle = metadata?.workspace?.name?.trim()?.takeIf { it.isNotEmpty() }
        ?: gitStatus?.branch?.trim()?.takeIf { it.isNotEmpty() }
        ?: metadata?.gitBranch?.trim()?.takeIf { it.isNotEmpty() }
    val rig = metadata.rigGitSummary()
    if (rig != null) {
        val changes = if (rig.insertions == 0L && rig.deletions == 0L) null else VisibleGitChanges(!rig.countsExact, rig.insertions, rig.deletions)
        return ChatHeaderGit(subtitle, changes)
    }
    val live = gitStatus?.takeIf { it.lastUpdatedAt > 0 }
    val changes = live?.takeIf { it.linesAdded > 0 || it.linesRemoved > 0 }?.let { VisibleGitChanges(false, it.linesAdded, it.linesRemoved) }
    return ChatHeaderGit(subtitle, changes)
}
