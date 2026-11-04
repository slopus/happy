package com.slopus.happy.agent

/** Happy Desktop's per-person auto-join keys; Surface auto-join arrived in daemon protocol 31. */
enum class AutoJoinKind(val key: String) {
    Tasks("tasks.autoJoin"), Surfaces("surfaces.autoJoin"),
}

sealed interface AgentSharingState {
    data object Loading : AgentSharingState
    data object Unsupported : AgentSharingState
    data class Ready(val tasks: Boolean, val surfaces: Boolean?) : AgentSharingState

    companion object {
        fun from(catalog: AgentCatalog, protocol: Int?): AgentSharingState = when {
            !catalog.loaded -> Loading
            !catalog.userSettingsSupported -> Unsupported
            else -> Ready(
                tasks = DesktopSettings.autoJoin(catalog.settingValues, AutoJoinKind.Tasks),
                surfaces = if ((protocol ?: 0) >= 31) DesktopSettings.autoJoin(catalog.settingValues, AutoJoinKind.Surfaces) else null,
            )
        }
    }
}