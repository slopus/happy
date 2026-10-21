package com.slopus.happy.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.diagnostics.ClientLogs
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.GitStatusFiles
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Session
import com.slopus.happy.model.displayName
import com.slopus.happy.model.resumeCommand
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.sync.OpResult
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.components.confirm
import com.slopus.happy.ui.home.ArchiveResult
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

/** Chat's header info button opens this. */
@Serializable data class SessionInfoRoute(val id: String)

object SessionInfoTags {
    const val LOADING = "sessionInfo.loading"
    const val DELETED = "sessionInfo.deleted"
    const val CHANGES = "sessionInfo.changes"
    const val MACHINE = "sessionInfo.machine"
    const val RESUME = "sessionInfo.resume"
    const val FORK = "sessionInfo.fork"
    const val DUPLICATE = "sessionInfo.duplicate"
    const val PARENT = "sessionInfo.parent"
    const val ARCHIVE = "sessionInfo.archive"
    const val DELETE = "sessionInfo.delete"
    const val OUTDATED = "sessionInfo.outdated"
    const val SESSION_ID = "sessionInfo.sessionId"
    const val RESUME_COMMAND = "sessionInfo.resumeCommand"
    const val COPY_METADATA = "sessionInfo.copyMetadata"
    const val COPY_METADATA_AND_LOGS = "sessionInfo.copyMetadataAndLogs"
    const val RAW_JSON = "sessionInfo.rawJson"
    const val SKIP_PERMISSIONS = "sessionInfo.skipPermissions"
}

/** info.tsx's icon colours (iOS system colours) and sizes. */
object SessionInfoSpec {
    val blue = Color(0xFF007AFF)
    val red = Color(0xFFFF3B30)
    val orange = Color(0xFFFF9500)
    val purple = Color(0xFF5856D6)
    val magenta = Color(0xFF9C27B0)
    val codex = Color(0xFF10A37F)
    val green = Color(0xFF30D158)
    val online = Color(0xFF34C759)
    val gray = Color(0xFF8E8E93)
    val yellow = Color(0xFFFFCC00)
    val icon = 29.dp
    val changesIcon = 26.dp
    val code = happyTextStyle(fontSize = 12, lineHeight = 18, family = PlexMono)
    const val UPDATE_COMMAND = "npm install -g happy@latest"
}

/**
 * What session info reads live beside the stored session: the checkout's
 * git status and file list (useSessionGitStatus, useSessionGitStatusFiles)
 * and the session's picks and draft (its composer mirror).
 */
@Immutable
data class SessionInfoLive(
    val gitStatus: GitStatus? = null,
    val gitStatusFiles: GitStatusFiles? = null,
    val composer: ComposerMirror = ComposerMirror(),
)

/** What info.tsx runs against the session; tests use a fake. */
interface SessionInfoControls {
    /** useSessionQuickActions' archive: kill, or retire on the server when the agent is gone. */
    suspend fun archive(session: Session): ArchiveResult

    /** sessionDelete, after a best-effort kill of a session still running. */
    suspend fun delete(session: Session): OpResult

    /** maybeCleanupWorktree, before an archive or delete: [confirm] asks whether to delete the worktree. */
    suspend fun cleanupWorktree(session: Session, confirm: suspend () -> Boolean) {}
}

@Immutable
class SessionInfoActions(
    val onBack: () -> Unit,
    val onOpenSession: (String) -> Unit,
    val onOpenMachine: (String) -> Unit,
    /** The session's changes screen. */
    val onChanges: (String) -> Unit,
    /**
     * Archived: leave this screen, and the chat behind it for [successor],
     * the checkout's neighbouring tab, when there is one ([tabSuccessor]).
     */
    val onArchived: (successor: String?) -> Unit,
    /** Deleted: leave this screen and the chat behind it. */
    val onDeleted: () -> Unit,
    /** Clipboard.setStringAsync; false when the system refused it. */
    val copyToClipboard: (String) -> Boolean,
    /** useWorktreeTabSuccessor, read when archive is pressed, before the chat leaves its checkout. */
    val tabSuccessor: (sessionId: String) -> String? = { null },
    /** log.getLogs() for "Copy session metadata & Client Logs". */
    val clientLogs: suspend () -> List<String> = { withContext(Dispatchers.IO) { ClientLogs.read() } },
    /** replaceToSession: a duplicated session takes this screen's place. */
    val onReplaceWithSession: (String) -> Unit = onOpenSession,
)

/**
 * session/[id]/info.tsx. The header names the session, centred. While the
 * first sync is out, an hourglass and "Loading"; a session that's gone says
 * so. Otherwise: quick actions (changes with Happy Agent's counts, the
 * machine, resume, fork, duplicate, the parent, archive and delete), the
 * outdated-CLI warning, the session's ids and times (each id copies), its
 * metadata, agent state, activity and, in dev mode, the raw JSON.
 *
 * Archive and delete first offer to delete a clean worktree nobody else is
 * in (maybeCleanupWorktree). An archived chat that was one tab of a
 * checkout hands over to its neighbouring tab.
 *
 * The Changes row counts Happy Agent's published comparison, else the
 * checkout's live git status ([SessionInfoLive]). The raw JSON group is for
 * debug builds only, as info.tsx's `__DEV__`.
 *
 * Deviations: a delete waits for the server instead of leaving first, so a
 * failure can still be shown here (there is no app-wide alert to show it
 * after leaving). Client logs are the app's own logcat.
 */
@Composable
fun SessionInfoScreen(
    session: Session?,
    ready: Boolean,
    agentState: JsonObject?,
    machine: Machine?,
    continuationExperiments: Boolean,
    debugBuild: Boolean,
    controls: SessionInfoControls,
    continuations: SessionContinuations,
    actions: SessionInfoActions,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
    live: SessionInfoLive = SessionInfoLive(),
) {
    val colors = HappyTheme.colors
    val newChat = stringResource(R.string.session_new_chat)
    val title = when {
        session != null -> session.displayName() ?: newChat
        ready -> stringResource(R.string.errors_session_deleted)
        else -> ""
    }
    Screen(
        modifier = modifier,
        header = { Header(title = title, alignment = TitleAlignment.Center, left = { HeaderBackButton(onClick = actions.onBack) }) },
    ) {
        when {
            !ready -> Placeholder(Ionicon.HourglassOutline, Modifier.testTag(SessionInfoTags.LOADING)) {
                Text(
                    stringResource(R.string.common_loading),
                    style = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold),
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 16.dp),
                )
            }
            session == null -> Placeholder(Ionicon.TrashOutline, Modifier.testTag(SessionInfoTags.DELETED)) {
                Text(
                    stringResource(R.string.errors_session_deleted),
                    style = happyTextStyle(fontSize = 20, weight = FontWeight.SemiBold),
                    color = colors.text,
                    modifier = Modifier.padding(top = 16.dp),
                )
                Text(
                    stringResource(R.string.errors_session_deleted_description),
                    style = happyTextStyle(fontSize = 15),
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 8.dp).padding(horizontal = 32.dp),
                )
            }
            else -> SessionInfoContent(session, agentState, machine, continuationExperiments, debugBuild, controls, continuations, actions, zone, live)
        }
    }
}

@Composable
private fun Placeholder(icon: Ionicon, modifier: Modifier, content: @Composable () -> Unit) {
    Column(
        modifier = modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, size = 48.dp, color = HappyTheme.colors.textSecondary)
        content()
    }
}
