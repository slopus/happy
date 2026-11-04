package com.slopus.happy.agent

import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.filter

/** The settled loaded home snapshots to keep on disk, including a home loaded before the writer starts. */
@OptIn(FlowPreview::class)
internal fun Flow<AgentCatalog>.cacheSnapshots(): Flow<AgentCatalog> =
    filter { it.loaded }.debounce(1_000)