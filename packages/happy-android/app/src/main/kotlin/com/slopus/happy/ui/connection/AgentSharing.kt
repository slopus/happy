package com.slopus.happy.ui.connection

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSharingState
import com.slopus.happy.agent.AutoJoinKind
import com.slopus.happy.ui.components.HappySwitch
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import kotlinx.serialization.Serializable

@Serializable data class AgentSharingRoute(val connectionId: String)

object AgentSharingTags {
    const val ROW = "agentSettings.sharing"
    fun toggle(kind: AutoJoinKind) = "sharing.${kind.name}"
}

@Composable
fun AgentSharingScreen(state: AgentSharingState, onAutoJoin: (AutoJoinKind, Boolean) -> Unit, onBack: () -> Unit) {
    AgentPage(stringResource(R.string.sharing_title), onBack) {
        when (state) {
            AgentSharingState.Loading -> ItemGroup { Item(stringResource(R.string.common_loading), loading = true) }
            AgentSharingState.Unsupported -> ItemGroup {
                Item(stringResource(R.string.sharing_unsupported), titleLines = 0)
            }
            is AgentSharingState.Ready -> {
                ItemGroup(footer = stringResource(R.string.sharing_footer)) {
                    AutoJoinRow(AutoJoinKind.Tasks, state.tasks, onAutoJoin)
                    state.surfaces?.let { AutoJoinRow(AutoJoinKind.Surfaces, it, onAutoJoin) }
                }
                if (state.surfaces == null) ItemGroup {
                    Item(stringResource(R.string.sharing_update), titleLines = 0)
                }
            }
        }
    }
}

@Composable
private fun AutoJoinRow(kind: AutoJoinKind, enabled: Boolean, onAutoJoin: (AutoJoinKind, Boolean) -> Unit) {
    val title = stringResource(if (kind == AutoJoinKind.Tasks) R.string.sharing_tasks else R.string.sharing_surfaces)
    Item(
        title = title,
        titleLines = 0,
        showChevron = false,
        rightElement = {
            HappySwitch(enabled, { onAutoJoin(kind, it) }, Modifier.testTag(AgentSharingTags.toggle(kind)), label = title)
        },
    )
}