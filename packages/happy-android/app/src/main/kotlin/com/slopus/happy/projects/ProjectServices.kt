package com.slopus.happy.projects

import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Project
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.InvalidateSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

/**
 * The signed-in account's project catalog (sync.ts projectsSync), kept
 * while the account is. It is asked again after every finished sync, when
 * the projects the stored sessions name change, and on every project
 * event the socket delivers.
 */
class ProjectServices private constructor(graph: AppGraph) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val api = ProjectApi(
        graph.http,
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build(),
        serverUrl = { graph.serverConfig.url.value },
    )

    @OptIn(ExperimentalCoroutinesApi::class)
    val projects: StateFlow<Map<String, Project>> = graph.account
        .flatMapLatest { account ->
            val signedIn = graph.auth.state.value as? AuthState.SignedIn
            if (account == null || signedIn == null) flowOf(emptyMap()) else follow(account, signedIn, graph.store)
        }
        .stateIn(scope, SharingStarted.Eagerly, emptyMap())

    private fun follow(account: AccountSync, signedIn: AuthState.SignedIn, store: HappyStore): Flow<Map<String, Project>> = channelFlow {
        val catalog = ProjectCatalog(
            signedIn.encryption,
            fetch = { ids -> api.fetch(signedIn.credentials.token, ids) },
            downloadAvatar = { id -> api.downloadAvatar(signedIn.credentials.token, id) },
        )
        launch { catalog.projects.collect { send(it) } }
        val sync = InvalidateSync(this) { catalog.refresh(linkedProjectIds(store)) }
        launch {
            store.versions.map { it.sessions }.distinctUntilChanged()
                .map { linkedProjectIds(store) }
                .distinctUntilChanged()
                .collect { sync.invalidate() }
        }
        // A sync just finished: fetchSessions ends by invalidating the catalog.
        launch { account.isSyncing.drop(1).filter { !it }.collect { sync.invalidate() } }
        launch { account.live.projectChanges.collect { sync.invalidate() } }
        awaitClose()
    }

    /** The project ids the stored sessions link to. */
    private fun linkedProjectIds(store: HappyStore): Set<String> =
        store.sessions().mapNotNullTo(HashSet()) { it.projectId?.trim()?.ifEmpty { null } }

    companion object {
        private val instances = WeakHashMap<AppGraph, ProjectServices>()

        fun of(graph: AppGraph): ProjectServices = synchronized(instances) { instances.getOrPut(graph) { ProjectServices(graph) } }
    }
}
