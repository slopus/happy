package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.diff.DiffFilesList
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ChangesTags {
    const val SPINNER = "changes.spinner"
    const val MESSAGE = "changes.message"
    const val RETRY = "changes.retry"
    const val NOTICES = "changes.notices"
}

/** What the changes screen shows: nothing known yet, a CLI session's uncommitted work, or Happy Agent's comparison. */
sealed interface ChangesContent {
    data object Loading : ChangesContent
    data class Legacy(val state: LegacyChanges.State) : ChangesContent
    data class Agent(val state: AgentChanges.State, val supported: Boolean) : ChangesContent
}

class ChangesActions(
    val onBack: () -> Unit = {},
    val onExpandContext: (String) -> Unit = {},
    val onRequestContent: (String) -> Unit = {},
    val onRetry: () -> Unit = {},
)

/**
 * session/[id]/changes.tsx: the session's changes as one scrolling diff,
 * under a plain header titled "View changes" (centred, back). Every file
 * starts collapsed (DiffFilesList `defaultCollapsed`); [scrollToFile]
 * scrolls to one. On the surface colour.
 *
 * AllFilesDiffView (CLI sessions): a spinner (20 padding, centred) until
 * the first diffs arrive; no files: "No changes to display" (14
 * textSecondary) centred. HappyAgentDiffView: a spinner while the snapshot
 * loads; a failure or a missing base: the message (14 textSecondary,
 * centred) and a semibold "Retry" padded 12, 8 below; notices (truncated,
 * approximate, conflicted) padded 16, 8 apart, above the files.
 */
@Composable
fun ChangesScreen(content: ChangesContent, actions: ChangesActions, scrollToFile: String? = null) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.session_info_view_changes), actions.onBack, TitleAlignment.Center) }) {
        Box(Modifier.fillMaxSize().background(colors.surface)) {
            when (content) {
                ChangesContent.Loading -> Spinner()
                is ChangesContent.Legacy -> LegacyBody(content.state, actions, scrollToFile)
                is ChangesContent.Agent -> AgentBody(content, actions, scrollToFile)
            }
        }
    }
}

@Composable
private fun LegacyBody(state: LegacyChanges.State, actions: ChangesActions, scrollToFile: String?) {
    val noChanges = stringResource(R.string.files_no_changes)
    when {
        state.files == null || state.loading -> Spinner()
        state.files.isEmpty() -> ChangesMessage(noChanges)
        else -> DiffFilesList(
            items = state.items,
            scrollToPath = scrollToFile,
            emptyText = noChanges,
            defaultCollapsed = true,
            onExpandContext = actions.onExpandContext,
        )
    }
}

@Composable
private fun AgentBody(content: ChangesContent.Agent, actions: ChangesActions, scrollToFile: String?) {
    val state = content.state
    val load = state.load
    when {
        !content.supported -> ChangesMessage("Update Happy Agent on your computer to view changes in this session.")
        load is AgentChanges.Load.Loading -> Spinner()
        load is AgentChanges.Load.Error -> ChangesMessage(load.message, actions.onRetry)
        load is AgentChanges.Load.Ready && (load.git.comparison != "ready" || load.git.base == null) ->
            ChangesMessage("A comparison with origin/main is not available for this workspace.", actions.onRetry)
        else -> {
            val notices = state.notices
            val colors = HappyTheme.colors
            DiffFilesList(
                items = state.items(stringResource(R.string.files_file_empty)),
                scrollToPath = scrollToFile,
                defaultCollapsed = true,
                onRequestContent = actions.onRequestContent,
                onExpandContext = actions.onExpandContext,
                emptyText = if (state.clean) stringResource(R.string.files_no_changes) else "No file details are available for this comparison.",
                header = if (notices.isEmpty()) null else {
                    {
                        Column(Modifier.fillMaxWidth().testTag(ChangesTags.NOTICES).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (notice in notices) Text(notice, style = messageStyle, color = colors.textSecondary)
                        }
                    }
                },
            )
        }
    }
}

private val messageStyle = happyTextStyle(fontSize = 14)
private val retryStyle = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold)

@Composable
private fun Spinner() {
    Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(20.dp).testTag(ChangesTags.SPINNER), color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp)
    }
}

@Composable
private fun ChangesMessage(message: String, onRetry: (() -> Unit)? = null) {
    val colors = HappyTheme.colors
    Column(
        Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, style = messageStyle, color = colors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.testTag(ChangesTags.MESSAGE))
        if (onRetry != null) {
            Text(
                stringResource(R.string.common_retry),
                style = retryStyle,
                color = colors.text,
                modifier = Modifier.padding(top = 8.dp).testTag(ChangesTags.RETRY).clickable(role = Role.Button, onClick = onRetry).padding(12.dp),
            )
        }
    }
}
