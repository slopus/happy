package com.slopus.happy.ui.home

import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MachineRecord
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.Machine
import com.slopus.happy.model.Project
import com.slopus.happy.model.ProjectAvatar
import com.slopus.happy.model.Session
import com.slopus.happy.sync.MachinePresence
import com.slopus.happy.sync.SessionPresence
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map

/** Everything the home list is derived from: storage.ts sessions, machines and projects, presence applied. */
data class HomeSnapshot(
    val sessions: List<Session>,
    val machines: List<Machine>,
    val projects: Map<String, Project> = emptyMap(),
    /** The daemon's working-tree status by checkout ([com.slopus.happy.model.gitStatusKey]). */
    val gitStatuses: Map<String, GitStatus> = emptyMap(),
    /**
     * useIsDataReady: a computer is known, or the first sync has finished.
     * Until then no machines means "not read yet", not "link a computer".
     */
    val ready: Boolean = true,
)

/**
 * The stored sessions and machines, re-read only when one of them changed
 * ([HappyStore.versions]), with the in-memory presence on top: online and
 * thinking come from [sessionPresence] and [machinePresence], never from the
 * stored `active` column. A record that didn't change keeps its parsed
 * object, so one chat's update doesn't re-parse every other. [synced] says
 * whether a sync has ever finished for this account.
 */
fun homeSnapshots(
    store: HappyStore,
    sessionPresence: Flow<Map<String, SessionPresence>>,
    machinePresence: Flow<Map<String, MachinePresence>>,
    synced: Flow<Boolean> = flowOf(true),
    projects: Flow<Map<String, Project>> = flowOf(emptyMap()),
    sessionAvatars: Flow<Map<String, ProjectAvatar>> = flowOf(emptyMap()),
    gitStatuses: Flow<Map<String, GitStatus>> = flowOf(emptyMap()),
    /** Each session's composer draft ([com.slopus.happy.sync.SessionComposer.mirrors]), for the rows' draft glyph. */
    drafts: Flow<Map<String, String>> = flowOf(emptyMap()),
    io: CoroutineDispatcher = Dispatchers.IO,
): Flow<HomeSnapshot> {
    val records = flow {
        val reader = RecordReader()
        store.versions
            .map { it.sessions to it.machines }
            .distinctUntilChanged()
            .collect { emit(reader.read(store)) }
    }.flowOn(io)
    val withAvatars = combine(records, sessionAvatars, drafts.distinctUntilChanged()) { (sessions, machines), avatars, texts ->
        sessions.map { session ->
            val avatar = avatars[session.id]
            val draft = texts[session.id]
            if (avatar == null && draft == null) session else session.copy(avatar = avatar ?: session.avatar, draft = draft)
        } to machines
    }
    val catalogs = combine(projects, gitStatuses, ::Pair)
    return combine(withAvatars, sessionPresence, machinePresence, synced.distinctUntilChanged(), catalogs) { (sessions, machines), sessionLive, machineLive, wasSynced, (catalog, git) ->
        HomeSnapshot(
            sessions = sessions.map { session -> sessionLive[session.id]?.let(session::withPresence) ?: session },
            machines = machines.map { machine -> machineLive[machine.id]?.let(machine::withPresence) ?: machine },
            projects = catalog,
            gitStatuses = git,
            ready = wasSynced || machines.isNotEmpty(),
        )
    }
}

fun Session.withPresence(presence: SessionPresence): Session =
    if (active == presence.active && activeAt == presence.activeAt && thinking == presence.thinking && thinkingAt == presence.thinkingAt) this
    else copy(active = presence.active, activeAt = presence.activeAt, thinking = presence.thinking, thinkingAt = presence.thinkingAt)

fun Machine.withPresence(presence: MachinePresence): Machine =
    if (active == presence.active && activeAt == presence.activeAt) this
    else copy(active = presence.active, activeAt = presence.activeAt)

private class RecordReader {
    private var sessions = emptyMap<String, Pair<SessionRecord, Session>>()
    private var machines = emptyMap<String, Pair<MachineRecord, Machine>>()

    fun read(store: HappyStore): Pair<List<Session>, List<Machine>> {
        val nextSessions = store.sessions().map { record ->
            sessions[record.id]?.takeIf { it.first == record } ?: (record to Session.from(record))
        }
        val nextMachines = store.machines().map { record ->
            machines[record.id]?.takeIf { it.first == record } ?: (record to Machine.from(record))
        }
        sessions = nextSessions.associateBy { it.first.id }
        machines = nextMachines.associateBy { it.first.id }
        return nextSessions.map { it.second } to nextMachines.map { it.second }
    }
}
