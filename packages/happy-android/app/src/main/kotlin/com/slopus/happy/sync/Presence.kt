package com.slopus.happy.sync

import com.slopus.happy.data.ActivityRow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What a session's status shows (sessionUtils.ts useSessionStatus): online
 * or not, thinking or not, and for an offline session when it was last seen.
 * While [active], [activeAt] is the time it came online; heartbeats do not
 * move it, because nothing displays them.
 */
data class SessionPresence(
    val active: Boolean,
    val activeAt: Long,
    val thinking: Boolean,
    val thinkingAt: Long,
)

data class MachinePresence(val active: Boolean, val activeAt: Long)

/** The latest `usage` ephemeral of a session (one per agent turn). */
data class SessionUsage(
    val key: String,
    val timestamp: Long,
    val tokens: ApiUsageTokens,
    val cost: ApiUsageCost,
)

/**
 * Presence of the account's sessions and machines, in memory only.
 *
 * Stored rows (from listings and live record updates) seed it; `activity`
 * and `machine-activity` ephemerals keep it current between them, and the
 * newer `activeAt` wins either way, as the server is the only authority on
 * whether something is online. Heartbeats arrive every few seconds per live
 * session: they move the internal timestamps and nothing else. [sessions]
 * and [machines] change only when something shown changes: a session or
 * machine going online or offline, starting or stopping thinking, or an
 * offline one's last-seen time. Nothing here is ever written to SQLite; the
 * next sync brings fresh rows anyway.
 */
class Presence(private val clock: () -> Long = System::currentTimeMillis) {
    private class Entry(var active: Boolean, var thinking: Boolean, var latestAt: Long, var shown: SessionPresence)

    private class MachineEntry(var active: Boolean, var latestAt: Long, var shown: MachinePresence)

    private val sessionEntries = HashMap<String, Entry>()
    private val machineEntries = HashMap<String, MachineEntry>()

    private val sessionState = MutableStateFlow<Map<String, SessionPresence>>(emptyMap())
    val sessions: StateFlow<Map<String, SessionPresence>> = sessionState.asStateFlow()

    private val machineState = MutableStateFlow<Map<String, MachinePresence>>(emptyMap())
    val machines: StateFlow<Map<String, MachinePresence>> = machineState.asStateFlow()

    private val usageState = MutableStateFlow<Map<String, SessionUsage>>(emptyMap())
    val usage: StateFlow<Map<String, SessionUsage>> = usageState.asStateFlow()

    /** Takes the stored sessions as they are now. Rows newer than what the socket said win; ids not listed go. */
    @Synchronized
    fun reconcileSessions(rows: List<ActivityRow>) {
        val ids = HashSet<String>()
        for (row in rows) {
            ids += row.id
            val entry = sessionEntries[row.id]
            if (entry == null) {
                sessionEntries[row.id] = Entry(row.active, false, row.activeAt, SessionPresence(row.active, row.activeAt, false, 0))
            } else if (row.activeAt > entry.latestAt) {
                update(entry, active = row.active, thinking = entry.thinking && row.active, at = row.activeAt)
            }
        }
        sessionEntries.keys.retainAll(ids)
        publishSessions()
    }

    @Synchronized
    fun reconcileMachines(rows: List<ActivityRow>) {
        val ids = HashSet<String>()
        for (row in rows) {
            ids += row.id
            val entry = machineEntries[row.id]
            if (entry == null) {
                machineEntries[row.id] = MachineEntry(row.active, row.activeAt, MachinePresence(row.active, row.activeAt))
            } else if (row.activeAt > entry.latestAt) {
                updateMachine(entry, row.active, row.activeAt)
            }
        }
        machineEntries.keys.retainAll(ids)
        publishMachines()
    }

    /** An `activity` ephemeral. Unknown sessions wait for their row; stale packets are ignored. */
    @Synchronized
    fun activity(id: String, active: Boolean, activeAt: Long, thinking: Boolean) {
        val entry = sessionEntries[id] ?: return
        if (activeAt < entry.latestAt) return
        if (update(entry, active, active && thinking, activeAt)) sessionState.value = sessionState.value + (id to entry.shown)
    }

    @Synchronized
    fun machineActivity(id: String, active: Boolean, activeAt: Long) {
        val entry = machineEntries[id] ?: return
        if (activeAt < entry.latestAt) return
        if (updateMachine(entry, active, activeAt)) machineState.value = machineState.value + (id to entry.shown)
    }

    /**
     * A turn started or ended, read from a message (sync.ts handleUpdate):
     * the message stream is the reliable signal when an ephemeral is lost.
     */
    @Synchronized
    fun setThinking(id: String, thinking: Boolean) {
        val entry = sessionEntries[id] ?: return
        if (update(entry, entry.active, thinking && entry.active, entry.latestAt)) sessionState.value = sessionState.value + (id to entry.shown)
    }

    @Synchronized
    fun usage(id: String, usage: SessionUsage) {
        if (usageState.value[id] == usage) return
        usageState.value = usageState.value + (id to usage)
    }

    @Synchronized
    fun removeSession(id: String) {
        if (sessionEntries.remove(id) != null) publishSessions()
        if (id in usageState.value) usageState.value = usageState.value - id
    }

    @Synchronized
    fun removeMachine(id: String) {
        if (machineEntries.remove(id) != null) publishMachines()
    }

    /** True when what is shown changed. */
    private fun update(entry: Entry, active: Boolean, thinking: Boolean, at: Long): Boolean {
        val flip = entry.active != active || entry.thinking != thinking
        entry.active = active
        entry.thinking = thinking
        entry.latestAt = at
        val shown = entry.shown
        entry.shown = when {
            flip -> SessionPresence(active, at, thinking, if (thinking != shown.thinking) clock() else shown.thinkingAt)
            // Offline, the time is on screen ("last seen 5 minutes ago").
            !active && at != shown.activeAt -> shown.copy(activeAt = at)
            else -> shown
        }
        return entry.shown != shown
    }

    private fun updateMachine(entry: MachineEntry, active: Boolean, at: Long): Boolean {
        val flip = entry.active != active
        entry.active = active
        entry.latestAt = at
        if (!flip && (active || at == entry.shown.activeAt)) return false
        entry.shown = MachinePresence(active, at)
        return true
    }

    private fun publishSessions() {
        val next = sessionEntries.mapValues { it.value.shown }
        if (next != sessionState.value) sessionState.value = next
    }

    private fun publishMachines() {
        val next = machineEntries.mapValues { it.value.shown }
        if (next != machineState.value) machineState.value = next
    }
}
