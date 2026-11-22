package com.slopus.happy.ui.home

import com.slopus.happy.model.DayTitle
import com.slopus.happy.model.HomeFilter
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
        unread: Set<String> = emptySet(),
        filter: HomeFilter = HomeFilter.All,
    ) = HomeListInputs(HomeSnapshot(sessions, machines), grouping, archiveHidden, emptySet(), unread, archiving, filter)

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

    /**
     * Unlike happy-app's shouldShowFirstRunInstall, no computer linked takes nothing over:
     * cached sessions list, and only an empty home gets the link state.
     */
    @Test fun noComputerLinkedStillListsSessions() {
        val unlinked = derive(inputs(listOf(cli("a", noon)), machines = emptyList()))
        assertEquals(HomeEmptyState.List, unlinked.emptyState)
        assertTrue(unlinked.rows.isNotEmpty())
        assertEquals(HomeEmptyState.Link, derive(inputs(emptyList(), machines = emptyList())).emptyState)
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

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun leavingTheHappyAccountReleasesItsListAndDoesNotReviveItOnSettingsChanges() = runTest {
        val snapshots = MutableStateFlow<HomeSnapshot?>(null)
        val settings = MutableStateFlow(Settings.Defaults)
        val model = HomeListModel(
            snapshots = snapshots,
            settings = settings,
            localSettings = MutableStateFlow(LocalSettingsValues.Defaults),
            unreadSessionIds = MutableStateFlow(emptySet()),
            archivingSessionIds = MutableStateFlow(emptySet()),
            scope = backgroundScope,
            dispatcher = UnconfinedTestDispatcher(testScheduler),
            zone = { zone },
        )
        snapshots.value = HomeSnapshot(listOf(cli("account-a", noon)), listOf(online))
        assertEquals(listOf("chat:account-a:last"), shape(model.state.value!!))

        // Opening an agent connection must release the old sessions and their metadata.
        snapshots.value = null
        assertNull(model.state.value)
        settings.value = Settings.Defaults.copy(hideInactiveSessions = false)
        assertNull(model.state.value)

        snapshots.value = HomeSnapshot(emptyList(), emptyList(), ready = false)
        assertNull(model.state.value)
        snapshots.value = HomeSnapshot(listOf(cli("account-b", noon)), listOf(online))
        assertEquals(listOf("chat:account-b:last"), shape(model.state.value!!))
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

    private fun botSession(id: String, at: Long = noon, active: Boolean = true, machineId: String = "m1") = session(
        id,
        metadata = metadata(path = "/Users/dev/$id") {
            put("machineId", machineId)
            putJsonObject("bot") {
                put("id", "b-$id")
                put("name", id)
                put("username", id)
                put("workspaceId", "w1")
                put("orderKey", "1")
            }
        },
        active = active,
        lastMessageSentAt = at,
    )

    private fun taskSession(id: String, at: Long = noon, active: Boolean = true, machineId: String = "m1") = session(
        id,
        metadata = metadata(path = "/Users/dev/$id") {
            put("machineId", machineId)
            putJsonObject("task") { put("id", "t-$id"); put("name", id); put("orderKey", "1") }
        },
        active = active,
        lastMessageSentAt = at,
    )

    @Test fun filterChipsFilterSessionsByKind() {
        val bot = botSession("bot1")
        val task = taskSession("task1")
        val proj = cli("proj1", noon)
        val sessions = listOf(bot, task, proj)

        // All: shows all sessions
        val allState = derive(inputs(sessions, filter = HomeFilter.All))
        assertEquals(HomeFilter.All, allState.filter)
        assertEquals(3, allState.rows.count { it is HomeRow.Chat })

        // Bots: shows only bot chats
        val botsState = derive(inputs(sessions, filter = HomeFilter.Bots))
        assertEquals(HomeFilter.Bots, botsState.filter)
        assertEquals(listOf("chat:bot1:last"), shape(botsState))

        // Tasks: shows only task chats
        val tasksState = derive(inputs(sessions, filter = HomeFilter.Tasks))
        assertEquals(HomeFilter.Tasks, tasksState.filter)
        assertEquals(listOf("chat:task1:last"), shape(tasksState))

        // Projects: shows only project chats
        val projectsState = derive(inputs(sessions, filter = HomeFilter.Projects))
        assertEquals(HomeFilter.Projects, projectsState.filter)
        assertEquals(listOf("chat:proj1:last"), shape(projectsState))
    }

    @Test fun filterChipsFilterUnreadChatsAndCalculateUnreadCount() {
        val s1 = cli("s1", noon)
        val s2 = cli("s2", noon - 1000)
        val s3 = botSession("bot1")
        val sessions = listOf(s1, s2, s3)

        // s1 and bot1 are unread
        val unreadState = derive(inputs(sessions, unread = setOf("s1", "bot1"), filter = HomeFilter.Unread))
        assertEquals(HomeFilter.Unread, unreadState.filter)
        assertEquals(2, unreadState.unreadCount)
        assertEquals(listOf("chat:bot1", "chat:s1:last"), shape(unreadState))

        // On All tab, unreadCount is still 2
        val allState = derive(inputs(sessions, unread = setOf("s1", "bot1"), filter = HomeFilter.All))
        assertEquals(2, allState.unreadCount)
        assertEquals(3, allState.rows.count { it is HomeRow.Chat })
    }

    @Test fun filterChipsEmptyStateWhenNoMatchingItems() {
        val sessions = listOf(cli("proj1", noon))

        // Filter to Bots when no bots exist
        val state = derive(inputs(sessions, filter = HomeFilter.Bots))
        assertEquals(HomeFilter.Bots, state.filter)
        assertTrue(state.rows.isEmpty())
        assertTrue(state.cards.isEmpty())
        // Account has sessions, so emptyState is List (handled by inline filter notice, not full-screen NoSessions)
        assertEquals(HomeEmptyState.List, state.emptyState)
    }

    @Test fun filterChipsRespectArchiveHiddenPerFilter() {
        val activeBot = botSession("bot-live", noon, active = true)
        val archivedBot = botSession("bot-archived", noon - day, active = false)
        val sessions = listOf(activeBot, archivedBot)

        // Bots filter with archiveHidden = true
        val hiddenState = derive(inputs(sessions, archiveHidden = true, filter = HomeFilter.Bots))
        assertTrue(hiddenState.hasArchivedSessions)
        assertTrue(hiddenState.archiveHidden)
        assertEquals(listOf("chat:bot-live:last", "toggle:show"), shape(hiddenState))

        // Bots filter with archiveHidden = false
        val shownState = derive(inputs(sessions, archiveHidden = false, filter = HomeFilter.Bots))
        assertTrue(shownState.hasArchivedSessions)
        assertFalse(shownState.archiveHidden)
        assertEquals(
            listOf("chat:bot-live:last", "toggle:hide", "header:Yesterday", "chat:bot-archived:archived:last"),
            shape(shownState),
        )

        // Tasks filter when no tasks exist: hasArchivedSessions is false, no toggle
        val tasksState = derive(inputs(sessions, archiveHidden = false, filter = HomeFilter.Tasks))
        assertFalse(tasksState.hasArchivedSessions)
        assertTrue(tasksState.rows.isEmpty())
    }

    @Test fun filterChipsCardGroupingsRemainVisuallyConsistent() {
        val bot = botSession("bot1", noon)
        val sessions = listOf(bot, cli("proj1", noon))
        val state = derive(inputs(sessions, filter = HomeFilter.Bots))
        assertEquals(1, state.cards.size)
        val card = state.cards[0]
        assertEquals("flat-session-bot1", card.key)
        // Single card in card group has first = true, last = true, separated = false
        val place = card.place!!
        assertTrue(place.first)
        assertTrue(place.last)
        assertFalse(place.separated)
    }

    @Test fun archivedProjectWithFlavorMatchesProjectsNotBots() {
        val archivedProj = session(
            "proj-arch",
            metadata = metadata(path = "/Users/dev/proj-arch") {
                put("machineId", "m1")
                put("flavor", "claude")
            },
            active = false,
            lastMessageSentAt = noon - day,
        )
        val sessions = listOf(archivedProj)

        val botsHidden = derive(inputs(sessions, archiveHidden = false, filter = HomeFilter.Bots))
        assertTrue(botsHidden.rows.isEmpty())

        val projShown = derive(inputs(sessions, archiveHidden = false, filter = HomeFilter.Projects))
        assertEquals(listOf("toggle:hide", "header:Yesterday", "chat:proj-arch:archived:last"), shape(projShown))
    }

    @Test fun unreadCountRespectsArchiveVisibility() {
        val live = cli("live", noon)
        val archived = cli("arch", noon - day, active = false)
        val sessions = listOf(live, archived)

        val hidden = derive(inputs(sessions, archiveHidden = true, unread = setOf("live", "arch"), filter = HomeFilter.All))
        assertEquals(1, hidden.unreadCount)

        val shown = derive(inputs(sessions, archiveHidden = false, unread = setOf("live", "arch"), filter = HomeFilter.All))
        assertEquals(2, shown.unreadCount)
    }
}
