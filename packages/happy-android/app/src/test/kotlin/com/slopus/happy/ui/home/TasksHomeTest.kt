package com.slopus.happy.ui.home

import com.slopus.happy.R
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.ProjectHomeRow
import com.slopus.happy.model.ProjectHomeSection
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.rigMetadataJson
import kotlinx.serialization.json.buildJsonObject
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.SessionListInputs
import com.slopus.happy.model.SessionListItem
import com.slopus.happy.model.avatarId
import com.slopus.happy.model.buildSessionListViewData
import com.slopus.happy.model.collectSessionPlaces
import com.slopus.happy.model.toFlatSessionRow
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.TaskOpResult
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * happy-ios 36b11c5bf: Happy Agent's tasks (`metadata.task`) on the Happy
 * CLI home. Under each computer's bots, in the person's own order; named,
 * placed and pictured by the task; left or archived only through their
 * machine, never on the server, and gone from every list once retired.
 */
class TasksHomeTest {
    private val zone = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 10, 16)

    private fun task(
        id: String,
        orderKey: String? = null,
        createdAt: Long = 0,
        leaves: Boolean = false,
        canArchive: Boolean? = null,
        active: Boolean = true,
        archived: Boolean = false,
        bot: Boolean = false,
    ) = session(
        id,
        metadata = SessionMetadata.parse(
            buildJsonObject {
                rigMetadataJson(rpcMethods = if (leaves) listOf("leaveTask") else emptyList()).forEach { (key, value) -> put(key, value) }
                put("path", "/h/Tasks/$id")
                putJsonObject("task") {
                    put("id", "t-$id")
                    put("name", "Task $id")
                    put("folderName", id)
                    orderKey?.let { put("orderKey", it) }
                    canArchive?.let { put("canArchive", it) }
                }
                if (archived) put("lifecycleState", "archived")
                if (bot) {
                    putJsonObject("bot") {
                        put("id", "b-$id"); put("name", "Bot $id"); put("username", id); put("workspaceId", "w"); put("orderKey", "a")
                        put("systemKey", JsonNull)
                    }
                }
            },
        )!!,
        active = active,
        createdAt = createdAt,
    )

    private fun items(sessions: List<Session>, archiving: Set<String> = emptySet()) =
        buildSessionListViewData(SessionListInputs(sessions, emptyMap(), archivingSessionIds = archiving), zone, today)

    private fun tasks(items: List<SessionListItem>) = items.filterIsInstance<SessionListItem.Tasks>().single().sessions.map { it.id }

    @Test fun tasksFollowThePersonsOwnOrderThenTheNewestUnjoined() {
        val list = items(
            listOf(
                task("old", createdAt = 1),
                task("five", orderKey = "5"),
                task("new", createdAt = 9),
                task("fortyfive", orderKey = "45"),
            ),
        )
        // Keys compare as plain strings, as they are made: "45" before "5".
        assertEquals(listOf("fortyfive", "five", "new", "old"), tasks(list))
    }

    @Test fun aTaskIsNamedAndPlacedByItsTaskAndWearsItsOwnFace() {
        val row = items(listOf(task("release"))).filterIsInstance<SessionListItem.Tasks>().single().sessions.single()
        assertEquals("Task release", row.name)
        assertEquals("~/Tasks/release", toFlatSessionRow(row).projectName)
        assertEquals("m1:task:t-release", task("release").avatarId())
        assertTrue(row.task)
    }

    @Test fun aRetiredTaskLeavesEveryListAndASessionNamingBothIsABot() {
        val list = items(
            listOf(task("live"), task("archived", archived = true), task("leaving"), task("both", bot = true)),
            archiving = setOf("leaving"),
        )
        assertEquals(listOf("live"), tasks(list))
        assertEquals(listOf("both"), list.filterIsInstance<SessionListItem.Bots>().single().sessions.map { it.id })
        assertTrue(list.none { it is SessionListItem.SessionItem })
    }

    @Test fun eachComputerListsItsTasksUnderItsBots() {
        val home = deriveHomeList(
            HomeListInputs(
                HomeSnapshot(listOf(task("a"), task("both", bot = true)), listOf(machine("m1", machineMetadata { put("displayName", "Studio") }, active = true))),
                SessionListGrouping.Project, true, emptySet(), emptySet(), emptySet(),
            ),
            zone,
            today,
        )
        val rows = home.rows.mapNotNull { (it as? HomeRow.Project)?.row }
        assertEquals(
            listOf("machine-m1", "section-bots:m1", "bot-both", "section-tasks:m1", "task-a"),
            rows.map { it.key },
        )
        assertEquals(ProjectHomeSection.Tasks, (rows[3] as ProjectHomeRow.Section).section)
    }

    @Test fun aTasksFolderIsNoPlaceForNewWork() {
        val places = collectSessionPlaces(listOf("m1"), listOf(task("a")))
        assertTrue(places.isEmpty())
    }

    @Test fun theMenuOffersLeaveAndArchiveOnlyWhereTheTaskAllowsThem() {
        assertEquals(listOf(SessionActionId.Details), sessionActionIds(task("a"), null, false, false))
        assertEquals(
            listOf(SessionActionId.Details, SessionActionId.LeaveTask, SessionActionId.Archive),
            sessionActionIds(task("a", leaves = true, canArchive = true), null, false, false),
        )
    }

    private class FakeActions(var leave: TaskOpResult = TaskOpResult.Done, var archiveTask: TaskOpResult = TaskOpResult.Done) : SessionActions {
        val calls = mutableListOf<String>()
        var archiver: SessionArchiver? = null
        var archivingDuringCall: Set<String>? = null

        override suspend fun kill(sessionId: String): OpResult = OpResult(true).also { calls += "kill:$sessionId" }
        override suspend fun archiveOnServer(sessionId: String): OpResult = OpResult(true).also { calls += "archive:$sessionId" }
        override suspend fun delete(sessionId: String): OpResult = OpResult(true)
        override suspend fun leaveTask(sessionId: String): TaskOpResult {
            calls += "leaveTask:$sessionId"
            archivingDuringCall = archiver?.archiving?.value
            return leave
        }
        override suspend fun archiveTask(sessionId: String): TaskOpResult = archiveTask.also { calls += "archiveTask:$sessionId" }
    }

    @Test fun leavingATaskTakesItsRowAtOnceAndBringsItBackWithTheMachinesWords() = runTest {
        val actions = FakeActions()
        val archiver = SessionArchiver(actions).also { actions.archiver = it }
        assertEquals(ArchiveResult.Archived, archiver.leave(task("a", leaves = true)))
        assertEquals(setOf("a"), actions.archivingDuringCall)

        actions.leave = TaskOpResult.Refused("Only members may leave")
        val failed = archiver.leave(task("b", leaves = true))
        assertEquals(ArchiveResult.TaskFailed(leave = true, TaskOpResult.Refused("Only members may leave")), failed)
        assertEquals(setOf("a"), archiver.archiving.value)
        assertEquals("Only members may leave", taskFailureMessage(failed as ArchiveResult.TaskFailed) { "#$it" })
    }

    @Test fun aTasksArchiveAsksOnlyItsMachine() = runTest {
        val actions = FakeActions(archiveTask = TaskOpResult.Unreachable)
        val archiver = SessionArchiver(actions)
        val failed = archiver.archive(task("a", canArchive = true)) as ArchiveResult.TaskFailed
        // Never killSession-then-server, as a session is.
        assertEquals(listOf("archiveTask:a"), actions.calls)
        assertEquals("#${R.string.task_archive_needs_machine}", taskFailureMessage(failed) { "#$it" })
        assertEquals("#${R.string.task_cannot_leave}", taskFailureMessage(ArchiveResult.TaskFailed(true, TaskOpResult.Unsupported)) { "#$it" })
        assertEquals("#${R.string.task_leave_needs_machine}", taskFailureMessage(ArchiveResult.TaskFailed(true, TaskOpResult.Unreachable)) { "#$it" })
    }
}
