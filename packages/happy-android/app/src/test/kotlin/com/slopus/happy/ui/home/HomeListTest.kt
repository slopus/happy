package com.slopus.happy.ui.home

import com.slopus.happy.model.DayTitle
import com.slopus.happy.sync.ForkSource
import com.slopus.happy.sync.OpResult
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.forkSource
import com.slopus.happy.model.Settings
import com.slopus.happy.model.settings.LocalSettingsValues
import com.slopus.happy.net.ConnectionStatus
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

/**
 * The home list's data: SessionsListWrapper's states, SessionsList's flat
 * rows (live by activity, then the archive by day behind its toggle), the
 * project rows, the diff that keeps unchanged rows as the same instance,
 * useSessionQuickActions' archive and menu, and sessionListTimestamp.ts.
 */
class HomeListTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 10, 16)
    private val noon = today.atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val day = 24L * 60 * 60 * 1000

    private fun cli(id: String, at: Long, active: Boolean = true, machineId: String = "m1", name: String? = null) = session(
        id,
        metadata = metadata(path = "/Users/dev/$id") {
            put("machineId", machineId)
            name?.let { putJsonObject("summary") { put("text", it); put("updatedAt", 0) } }
        },
        active = active,
        lastMessageSentAt = at,
    )

    private val online = machine("m1", machineMetadata { put("displayName", "Studio") }, active = true)
    private val offline = machine("m1", machineMetadata { put("displayName", "Studio") }, active = false)

    private fun inputs(
        sessions: List<com.slopus.happy.model.Session>,
        machines: List<com.slopus.happy.model.Machine> = listOf(online),
        grouping: SessionListGrouping = SessionListGrouping.Flat,
        archiveHidden: Boolean = true,
        archiving: Set<String> = emptySet(),
    ) = HomeListInputs(HomeSnapshot(sessions, machines), grouping, archiveHidden, emptySet(), emptySet(), archiving)

    private fun derive(inputs: HomeListInputs) = deriveHomeList(inputs, zone, today)

    private fun shape(state: HomeListState) = state.rows.map { row ->
        when (row) {
            is HomeRow.Chat -> "chat:${row.row.session.id}${if (row.archived) ":archived" else ""}${if (row.showBorder) "" else ":last"}"
            is HomeRow.ArchiveToggle -> if (row.hidden) "toggle:show" else "toggle:hide"
            is HomeRow.DayHeader -> "header:${row.title}"
            is HomeRow.Project -> "project:${row.row.key}"
        }
    }

    @Test fun flatListPutsLiveChatsByActivityThenTheArchiveByDay() {
        val state = derive(
            inputs(
                listOf(
                    cli("old", noon - 3 * 60_000),
                    cli("new", noon - 60_000),
                    cli("gone-today", noon - 2 * 60_000, active = false),
                    cli("gone-yesterday", noon - day, active = false),
                ),
                archiveHidden = false,
            ),
        )
        assertEquals(
            listOf(
                "chat:new", "chat:old:last", "toggle:hide",
                "header:Today", "chat:gone-today:archived", "header:Yesterday", "chat:gone-yesterday:archived:last",
            ),
            shape(state),
        )
        assertTrue((state.rows[2] as HomeRow.ArchiveToggle).banded)
        assertEquals(DayTitle.Yesterday, (state.rows[5] as HomeRow.DayHeader).title)
        assertEquals(HomeEmptyState.List, state.emptyState)
    }

    @Test fun hiddenArchiveLeavesOnlyItsToggle() {
        val state = derive(inputs(listOf(cli("live", noon), cli("gone", noon, active = false))))
        assertEquals(listOf("chat:live:last", "toggle:show"), shape(state))
        assertTrue(state.hasArchivedSessions)
    }

    @Test fun archivingAChatTakesItOutOfTheLiveRowsAtOnce() {
        val state = derive(inputs(listOf(cli("a", noon), cli("b", noon - 1)), archiving = setOf("a")))
        assertEquals(listOf("chat:b:last", "toggle:show"), shape(state))
    }

    @Test fun homeStatesFollowMachinesAndSessions() {
        assertEquals(HomeEmptyState.Link, derive(inputs(emptyList(), machines = emptyList())).emptyState)
        assertEquals(HomeEmptyState.NoSessions, derive(inputs(emptyList())).emptyState)
        val allOffline = derive(inputs(emptyList(), machines = listOf(offline)))
        assertEquals(HomeEmptyState.Offline, allOffline.emptyState)
        assertEquals(OfflineBanner("Studio"), allOffline.offlineBanner)
        // An archive-only account with a reachable machine lists its archive control.
        assertEquals(HomeEmptyState.List, derive(inputs(listOf(cli("gone", noon, active = false)))).emptyState)
        assertNull(derive(inputs(listOf(cli("a", noon)))).offlineBanner)
    }

    /** index.tsx shouldShowFirstRunInstall: no computer at all, and the link page takes over even with sessions listed. */
    @Test fun noComputerLinkedShowsTheLinkPageOverSessions() {
        val unlinked = derive(inputs(listOf(cli("a", noon)), machines = emptyList()))
        assertEquals(HomeEmptyState.List, unlinked.emptyState)
        assertTrue(unlinked.showsInstallStep)
        assertTrue(derive(inputs(emptyList(), machines = emptyList())).showsInstallStep)
        // An offline computer is still linked.
        assertFalse(derive(inputs(listOf(cli("a", noon)), machines = listOf(offline))).showsInstallStep)
    }

    @Test fun offlinePlaqueNamesNoMachineWhenThereAreSeveral() {
        val two = listOf(offline, machine("m2", machineMetadata(host = "other"), active = false))
        assertEquals(OfflineBanner(null), derive(inputs(listOf(cli("a", noon)), machines = two)).offlineBanner)
    }

    @Test fun projectGroupingBuildsTheHierarchy() {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        val state = derive(
            inputs(
                listOf(session("s1", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon)),
                machines = listOf(rig),
                grouping = SessionListGrouping.Project,
            ),
        )
        assertEquals(listOf("project:machine-machine-1", "project:section-projects:machine-1", "project:project-p1"), shape(state))
        assertTrue((state.rows[2] as HomeRow.Project).row is ProjectHomeRow.ProjectCard)
    }

    @Test fun rebuildKeepsEveryUnchangedRowAsTheSameInstance() {
        val sessions = listOf(cli("a", noon), cli("b", noon - 1), cli("c", noon - 2))
        val first = derive(inputs(sessions))
        val second = reuseUnchanged(first, derive(inputs(sessions.map { if (it.id == "b") it.copy(thinking = true) else it })))
        assertNotSame(first.rows, second.rows)
        assertSame(first.rows[0], second.rows[0])
        assertNotSame(first.rows[1], second.rows[1])
        assertSame(first.rows[2], second.rows[2])
        // Nothing changed: the previous state itself.
        assertSame(second, reuseUnchanged(second, derive(inputs(sessions.map { if (it.id == "b") it.copy(thinking = true) else it }))))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun modelDerivesInTheBackgroundAndRecomputesOnAnyInput() = runTest {
        val snapshots = MutableStateFlow<HomeSnapshot?>(null)
        val settings = MutableStateFlow(Settings.Defaults)
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val model = HomeListModel(
            snapshots = snapshots,
            settings = settings,
            localSettings = MutableStateFlow(LocalSettingsValues.Defaults),
            unreadSessionIds = MutableStateFlow(emptySet()),
            archivingSessionIds = MutableStateFlow(emptySet()),
            scope = backgroundScope,
            dispatcher = dispatcher,
            zone = { zone },
        )
        assertNull(model.state.value)
        snapshots.value = HomeSnapshot(listOf(cli("a", noon), cli("b", noon - 1)), listOf(online))
        val first = model.state.value!!
        assertEquals(2, first.rows.size)

        snapshots.value = HomeSnapshot(listOf(cli("a", noon), cli("b", noon - 1).copy(thinking = true)), listOf(online))
        val second = model.state.value!!
        assertSame(first.rows[0], second.rows[0])
        assertNotSame(first.rows[1], second.rows[1])

        settings.value = Settings.Defaults.copy(sessionListGrouping = SessionListGrouping.Project)
        assertEquals(SessionListGrouping.Project, model.state.value!!.grouping)
    }

    @Test fun presenceDecidesOnlineAndThinking() {
        val stored = cli("a", noon, active = false)
        val live = stored.withPresence(com.slopus.happy.sync.SessionPresence(active = true, activeAt = 5, thinking = true, thinkingAt = 5))
        assertTrue(live.active)
        assertTrue(live.thinking)
        assertSame(live, live.withPresence(com.slopus.happy.sync.SessionPresence(true, 5, true, 5)))
    }

    private class FakeActions(
        var kill: OpResult = OpResult(true),
        var archive: OpResult = OpResult(true),
    ) : SessionActions {
        val calls = mutableListOf<String>()
        var archivingDuringCall: Set<String>? = null
        var archiver: SessionArchiver? = null

        override suspend fun kill(sessionId: String): OpResult {
            calls += "kill:$sessionId"
            archivingDuringCall = archiver?.archiving?.value
            return kill
        }

        override suspend fun archiveOnServer(sessionId: String): OpResult {
            calls += "archive:$sessionId"
            return archive
        }

        override suspend fun delete(sessionId: String): OpResult = OpResult(true)
    }

    @Test fun archiveKillsAndLeavesTheListOnThePress() = runTest {
        val actions = FakeActions()
        val archiver = SessionArchiver(actions).also { actions.archiver = it }
        assertEquals(ArchiveResult.Archived, archiver.archive(cli("a", noon)))
        assertEquals(listOf("kill:a"), actions.calls)
        assertEquals(setOf("a"), actions.archivingDuringCall)
        assertEquals(setOf("a"), archiver.archiving.value)
    }

    @Test fun archiveFallsBackToTheServerForAnUnreachableAgent() = runTest {
        val actions = FakeActions(kill = OpResult(false, "offline"))
        val archiver = SessionArchiver(actions)
        assertEquals(ArchiveResult.Archived, archiver.archive(cli("a", noon)))
        assertEquals(listOf("kill:a", "archive:a"), actions.calls)
    }

    @Test fun failedArchiveBringsTheRowBack() = runTest {
        val actions = FakeActions(kill = OpResult(false, null), archive = OpResult(false, "Server error: 500"))
        val archiver = SessionArchiver(actions)
        assertEquals(ArchiveResult.Failed("Server error: 500", bot = false), archiver.archive(cli("a", noon)))
        assertEquals(emptySet<String>(), archiver.archiving.value)
    }

    @Test fun botIsOnlyKilled() = runTest {
        val actions = FakeActions(kill = OpResult(false, null))
        val archiver = SessionArchiver(actions)
        val bot = session("bot", metadata = metadata {
            putJsonObject("bot") {
                put("id", "b1")
                put("name", "Helper")
                put("username", "helper")
                put("workspaceId", "w")
                put("orderKey", "a")
                put("systemKey", kotlinx.serialization.json.JsonNull)
            }
        })
        assertEquals(ArchiveResult.Failed(null, bot = true), archiver.archive(bot))
        assertEquals(listOf("kill:bot"), actions.calls)
    }

    private fun resumable(active: Boolean = false, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}) = session(
        "s",
        metadata = metadata {
            put("machineId", "m1")
            put("claudeSessionId", "claude-1")
            extra()
        },
        active = active,
    )

    private val resumeMachine = machine("m1", machineMetadata { putJsonObject("resumeSupport") { put("rpcAvailable", true) } })

    @Test fun resumeIsForADisconnectedCliSessionOnItsOnlineMachine() {
        assertEquals(ResumeAvailability(true, true, null), resumeAvailability(resumable(), resumeMachine))
        assertEquals(ResumeAvailability.Hidden, resumeAvailability(resumable(active = true), resumeMachine))
        assertEquals(ResumeAvailability.blocked(ResumeBlock.SameMachineOnly), resumeAvailability(resumable(), null))
        assertEquals(ResumeAvailability.blocked(ResumeBlock.MachineOffline), resumeAvailability(resumable(), resumeMachine.copy(active = false)))
        assertEquals(ResumeAvailability.Hidden, resumeAvailability(resumable(), machine("m1")))
        assertEquals(
            ResumeAvailability.blocked(ResumeBlock.MissingBackendId),
            resumeAvailability(session("s", metadata = metadata { put("machineId", "m1") }, active = false), resumeMachine),
        )
        assertEquals(ResumeAvailability.blocked(ResumeBlock.MissingMachine), resumeAvailability(session("s", active = false), resumeMachine))
        assertEquals(ResumeAvailability.Hidden, resumeAvailability(session("s", metadata = rigMetadata(), active = false), resumeMachine))
    }

    @Test fun sessionMenuListsItsActionsInOrder() {
        val live = resumable(active = true) { put("path", "/repo") }
        assertEquals(
            listOf(SessionActionId.Details, SessionActionId.Fork, SessionActionId.Duplicate, SessionActionId.Archive),
            sessionActionIds(live, resumeMachine, continuationExperiments = true, devMode = false),
        )
        assertEquals(
            listOf(SessionActionId.Details, SessionActionId.Resume, SessionActionId.CopyMetadata, SessionActionId.CopyMetadataAndLogs, SessionActionId.Archive),
            sessionActionIds(resumable(), resumeMachine, continuationExperiments = false, devMode = true),
        )
        assertTrue(live.forkSource() is ForkSource.Claude)
    }

    @Test fun timestampsReadLikeAChatList() {
        val now = noon
        // The JDK's CLDR data puts a narrow no-break space before the period, as current ICU does in JS.
        assertEquals("11:55 AM", formatSessionListTimestamp(now - 5 * 60_000, now, zone, Locale.US).replace('\u202F', ' '))
        assertEquals("Mon", formatSessionListTimestamp(now - 4 * day, now, zone, Locale.US))
        assertEquals("09/01", formatSessionListTimestamp(LocalDate.of(2026, 9, 1).atStartOfDay(zone).toInstant().toEpochMilli(), now, zone, Locale.US))
        assertEquals("12/31/25", formatSessionListTimestamp(LocalDate.of(2025, 12, 31).atStartOfDay(zone).toInstant().toEpochMilli(), now, zone, Locale.US))
    }

    @Test fun headerShowsOnlyAnUnhealthySocket() {
        assertFalse(shouldShowHomeConnectionStatus(ConnectionStatus.CONNECTED))
        assertTrue(shouldShowHomeConnectionStatus(ConnectionStatus.CONNECTING))
        assertTrue(shouldShowHomeConnectionStatus(ConnectionStatus.DISCONNECTED))
        assertTrue(shouldShowHomeConnectionStatus(ConnectionStatus.ERROR))
        assertFalse(shouldShowHomeConnectionStatus(ConnectionStatus.ERROR, hasCustomSubtitle = true))
    }
}
