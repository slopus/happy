package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Mode
import com.slopus.happy.ui.chat.rememberCopyText
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.theme.HappyTheme
import java.text.DateFormat
import java.util.Date

object ConversationDetailsTags {
    const val LOADING = "conversationDetails.loading"
    const val ERROR = "conversationDetails.error"
    const val LIST = "conversationDetails.list"
}

/**
 * A conversation's details: the standard header ("Chat details", back) in
 * the grouped background, as the cards sit on,
 * then settings cards (ItemGroup). Conversation: title, status, model,
 * effort, permission mode, subtasks running of total, created and updated.
 * Identifiers: the agent and workspace ids, each copied on tap. A
 * subagent says it was started by another agent. Before the agent is read
 * a 24 spinner is centred; a failed read says why, 16/24 textSecondary, 32
 * in. Only what the computer reports is shown; nothing here edits.
 */
@Composable
fun ConversationDetailsScreen(agent: AgentInfo?, mode: Mode?, error: String?, onBack: () -> Unit) {
    val colors = HappyTheme.colors
    Screen(header = { Header(title = stringResource(R.string.conversation_details), left = { HeaderBackButton(onBack) }, background = colors.grouped.background) }) {
        when {
            agent == null && error != null -> Text(
                error,
                style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(32.dp).testTag(ConversationDetailsTags.ERROR),
            )
            agent == null -> CircularProgressIndicator(
                color = colors.textSecondary,
                strokeWidth = 2.dp,
                modifier = Modifier.align(Alignment.Center).size(24.dp).testTag(ConversationDetailsTags.LOADING),
            )
            else -> Box(Modifier.fillMaxSize().testTag(ConversationDetailsTags.LIST)) { Details(agent, mode) }
        }
    }
}

@Composable
private fun Details(agent: AgentInfo, mode: Mode?) {
    val copy = rememberCopyText()
    val format = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
    ItemList {
        ItemGroup(title = stringResource(R.string.conversation_details_conversation)) {
            Item(stringResource(R.string.conversation_details_title), detail = agent.title?.ifBlank { null } ?: stringResource(R.string.conversation_untitled), showChevron = false)
            Item(
                stringResource(R.string.conversation_details_status),
                detail = stringResource(if (agent.isWorking) R.string.conversation_status_working else R.string.conversation_status_idle),
                showChevron = false,
            )
            if (mode != null) {
                Item(stringResource(R.string.conversation_details_model), detail = mode.modelId, subtitle = mode.providerId, showChevron = false)
                Item(stringResource(R.string.conversation_details_effort), detail = mode.effort, showChevron = false)
                Item(stringResource(R.string.conversation_details_permission_mode), detail = mode.permissionMode, showChevron = false)
            }
            if (agent.subagentsTotal > 0) {
                Item(
                    stringResource(R.string.conversation_details_subtasks),
                    detail = stringResource(R.string.conversation_details_subtasks_value, agent.subagentsRunning, agent.subagentsTotal),
                    showChevron = false,
                )
            }
            if (agent.isSubagent) Item(stringResource(R.string.conversation_details_parent), showChevron = false)
            agent.createdAt?.let { Item(stringResource(R.string.conversation_details_created), detail = format.format(Date(it)), showChevron = false) }
            agent.updatedAt?.let { Item(stringResource(R.string.conversation_details_updated), detail = format.format(Date(it)), showChevron = false) }
        }
        ItemGroup(title = stringResource(R.string.conversation_details_identifiers)) {
            Item(stringResource(R.string.conversation_details_agent_id), subtitle = agent.id, onClick = { copy(agent.id) }, showChevron = false)
            agent.workspaceId?.let { id ->
                Item(stringResource(R.string.conversation_details_workspace_id), subtitle = id, onClick = { copy(id) }, showChevron = false)
            }
        }
    }
}
