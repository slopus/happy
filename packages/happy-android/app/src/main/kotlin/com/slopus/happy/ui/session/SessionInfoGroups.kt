package com.slopus.happy.ui.session

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.model.Session
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.ui.chat.rememberComposerStatus
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.home.formatLocaleDateTime
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.time.ZoneId

/** info.tsx's Agent State group: whether the user has the terminal, and pending permission requests. */
@Composable
internal fun AgentStateGroup(agentState: JsonObject) {
    ItemGroup(title = stringResource(R.string.session_info_agent_state)) {
        val controlled = (agentState["controlledByUser"] as? JsonPrimitive)?.booleanOrNull == true
        Item(
            title = stringResource(R.string.session_info_controlled_by_user),
            detail = stringResource(if (controlled) R.string.common_yes else R.string.common_no),
            icon = { Icon(Ionicon.PersonOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.orange) },
            showChevron = false,
        )
        val requests = (agentState["requests"] as? JsonObject)?.size ?: 0
        if (requests > 0) {
            Item(
                title = stringResource(R.string.session_info_pending_requests),
                detail = requests.toString(),
                icon = { Icon(Ionicon.HourglassOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.orange) },
                showChevron = false,
            )
        }
    }
}

/** info.tsx's Activity group: thinking, and what the session's runtime reports running (metadata.activity). */
@Composable
internal fun ActivityGroup(session: Session, zone: ZoneId) {
    val metadata = session.metadata
    ItemGroup(title = stringResource(R.string.session_info_activity)) {
        Item(
            title = stringResource(R.string.session_info_thinking),
            detail = stringResource(if (session.thinking) R.string.common_yes else R.string.common_no),
            icon = { Icon(Ionicon.BulbOutline, size = SessionInfoSpec.icon, color = if (session.thinking) SessionInfoSpec.yellow else SessionInfoSpec.gray) },
            showChevron = false,
        )
        if (session.thinking) {
            Item(
                title = stringResource(R.string.session_info_thinking_since),
                subtitle = formatLocaleDateTime(session.thinkingAt, zone),
                icon = { Icon(Ionicon.TimerOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.yellow) },
                showChevron = false,
            )
        }
        metadata?.activity?.let { activity ->
            if (activity.subagentsRunning + activity.subagentsQueued > 0) {
                DetailRow(
                    stringResource(R.string.home_info_subagents),
                    stringResource(R.string.home_info_subagents_detail, formatNumber(activity.subagentsRunning), formatNumber(activity.subagentsQueued)),
                    Ionicon.PeopleOutline,
                )
            }
            if (activity.workflowsRunning > 0) {
                DetailRow(stringResource(R.string.home_info_workflows), stringResource(R.string.home_info_running, formatNumber(activity.workflowsRunning)), Ionicon.GitNetworkOutline)
            }
            if (activity.processesRunning > 0) {
                DetailRow(stringResource(R.string.home_info_processes), stringResource(R.string.home_info_running, formatNumber(activity.processesRunning)), Ionicon.TerminalOutline)
            }
            if (activity.tasksPending + activity.tasksInProgress > 0) {
                DetailRow(
                    stringResource(R.string.home_info_tasks),
                    stringResource(R.string.home_info_tasks_detail, formatNumber(activity.tasksInProgress), formatNumber(activity.tasksPending)),
                    Ionicon.CheckboxOutline,
                )
            }
        }
    }
}

/** info.tsx's Raw JSON group: the agent state, metadata, status and session as they are dumped. */
@Composable
internal fun RawJsonGroup(session: Session, agentState: JsonObject?, composer: ComposerMirror) {
    val metadata = session.metadata
    ItemGroup(title = stringResource(R.string.home_info_raw_json), modifier = Modifier.testTag(SessionInfoTags.RAW_JSON)) {
        agentState?.let {
            RawJson(stringResource(R.string.home_info_raw_agent_state), Ionicon.CodeWorkingOutline, SessionInfoSpec.orange, it)
        }
        metadata?.let {
            RawJson(stringResource(R.string.home_info_raw_metadata), Ionicon.InformationCircleOutline, SessionInfoSpec.purple, it.raw)
        }
        RawJson(
            stringResource(R.string.home_info_raw_status),
            Ionicon.AnalyticsOutline,
            SessionInfoSpec.blue,
            statusJson(session.state, rememberComposerStatus(session.state, session.activeAt).text),
        )
        RawJson(stringResource(R.string.home_info_raw_session), Ionicon.DocumentTextOutline, SessionInfoSpec.online, sessionJson(session, agentState, composer))
    }
}
