package com.slopus.happy.ui.tablet

import com.slopus.happy.model.DayTitle
import com.slopus.happy.model.GitStatus
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.ProjectGroupData
import com.slopus.happy.model.ProjectSource
import com.slopus.happy.model.ProjectWorkspaceGroup
import com.slopus.happy.model.SessionListItem
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.VisibleGitChanges
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

/** SessionsList.tsx's grouped data and ProjectGroup's headings (sessionDisplayOrder.ts buildSessionProjectDisplayGroups). */
class TabletGroupedListTest {
    private fun row(id: String, machineId: String? = "m-a", path: String? = "/repo/$id", gitChangedFiles: Long? = null, insertions: Long? = null) =
        SessionRowData(id = id, name = id, machineId = machineId, path = path, gitChangedFiles = gitChangedFiles, gitInsertions = insertions, gitDeletions = 0)

    private fun project(name: String, machineId: String?, vararg workspaces: ProjectWorkspaceGroup) = SessionListItem.ProjectItem(
        ProjectSource.Happy,
        ProjectGroupData("id-$name", name, machineId, workspaces.toList(), workspaces.sumOf { it.sessions.size }, 0),
    )

    private fun status(branch: String?, added: Long = 0, removed: Long = 0) =
        GitStatus(branch, added + removed > 0, 0, 0, 0, 0, 0, 0, added, removed, added, removed, added + removed)

    private val online = listOf(
        machine("m-a", machineMetadata { put("displayName", "Studio") }),
        machine("m-b", machineMetadata { put("displayName", "Laptop") }),
    )

    private fun build(items: List<SessionListItem>, statuses: Map<String, GitStatus> = emptyMap(), hasArchived: Boolean = false, hidden: Boolean = true) =
        buildTabletGroupedRows(items, online, statuses, hasArchived, hidden, "unknown")

    private fun shape(rows: List<TabletGroupedRow>) = rows.map { row ->
        when (row) {
            is TabletGroupedRow.Bots -> "bots:${row.sessions.joinToString(",") { it.id }}"
            is TabletGroupedRow.MachineHeader -> "machine:${row.machineName}"
            is TabletGroupedRow.Checkout ->
                "checkout:${row.projectName}/${row.branch ?: "main"}:${row.workspace.sessions.joinToString(",") { it.id }}${if (row.lastOfProject) ":last" else ""}"
            is TabletGroupedRow.ArchiveToggle -> if (row.hidden) "archive:show" else "archive:hide"
            is TabletGroupedRow.DayHeader -> "day:${row.day}"
            is TabletGroupedRow.ArchivedSession -> "card:${row.session.id}${if (row.first) ":first" else ""}${if (row.last) ":last" else ""}"
        }
    }

    @Test
    fun botsThenEachComputerByNameThenItsProjectsByName() {
        val items = listOf(
            project("zeta", "m-a", ProjectWorkspaceGroup("", null, listOf(row("z1")))),
            SessionListItem.Bots(listOf(row("bot"))),
            project("alpha", "m-a", ProjectWorkspaceGroup("", null, listOf(row("a1"), row("a2"))), ProjectWorkspaceGroup("wt", "feature", listOf(row("a3")))),
            project("beta", "m-b", ProjectWorkspaceGroup("", null, listOf(row("b1", machineId = "m-b")))),
            project("lost", null, ProjectWorkspaceGroup("", null, listOf(row("l1", machineId = null)))),
            // An offline computer isn't among useAllMachines(), so it goes by its id.
            project("gamma", "m-offline", ProjectWorkspaceGroup("", null, listOf(row("g1", machineId = "m-offline")))),
        )
        assertEquals(
            listOf(
                "bots:bot",
                "machine:Laptop",
                "checkout:beta/main:b1:last",
                "machine:m-offline",
                "checkout:gamma/main:g1:last",
                "machine:Studio",
                "checkout:alpha/main:a1,a2",
                "checkout:alpha/feature:a3:last",
                "checkout:zeta/main:z1:last",
                "machine:<unknown>",
                "checkout:lost/main:l1:last",
            ),
            shape(build(items)),
        )
    }

    @Test
    fun theBranchIsTheWorktreeThenTheLiveBranchThenMain() {
        val statuses = mapOf("m-a:/repo/a1" to status("develop"), "m-a:/repo/b1" to status(null))
        val rows = build(
            listOf(
                project("a", "m-a", ProjectWorkspaceGroup("", null, listOf(row("a1"))), ProjectWorkspaceGroup("wt-id", null, listOf(row("a2")))),
                project("b", "m-a", ProjectWorkspaceGroup("", null, listOf(row("b1")))),
            ),
            statuses,
        ).filterIsInstance<TabletGroupedRow.Checkout>()
        assertEquals(listOf("develop", "wt-id", null), rows.map { it.branch })
    }

    @Test
    fun theCountsAreTheUnstagedLinesElseHappyAgentsOwn() {
        assertEquals(VisibleGitChanges(false, 5, 2), checkoutChanges(row("a", gitChangedFiles = 3, insertions = 40), status("main", 5, 2)))
        assertEquals(VisibleGitChanges(false, 40, 0), checkoutChanges(row("a", gitChangedFiles = 3, insertions = 40), status("main")))
        assertNull(checkoutChanges(row("a"), status("main")))
        assertNull(checkoutChanges(null, null))
    }

    @Test
    fun theArchiveFollowsItsToggleAsCardsByDay() {
        val today = LocalDate.of(2026, 10, 16)
        val rows = build(
            listOf(
                project("a", "m-a", ProjectWorkspaceGroup("", null, listOf(row("a1")))),
                SessionListItem.Header(DayTitle.Today, today),
                SessionListItem.SessionItem(row("x")),
                SessionListItem.SessionItem(row("y")),
                SessionListItem.Header(DayTitle.Yesterday, today.minusDays(1)),
                SessionListItem.SessionItem(row("z")),
            ),
            hasArchived = true,
            hidden = false,
        )
        assertEquals(
            listOf(
                "machine:Studio",
                "checkout:a/main:a1:last",
                "archive:hide",
                "day:2026-10-16",
                "card:x:first",
                "card:y:last",
                "day:2026-10-15",
                "card:z:first:last",
            ),
            shape(rows),
        )
        assertEquals(listOf("archive:show"), shape(build(emptyList(), hasArchived = true)))
    }
}
