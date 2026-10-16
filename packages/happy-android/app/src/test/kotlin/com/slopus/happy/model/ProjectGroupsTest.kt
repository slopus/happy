package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

/** sync/projectGroups.spec.ts */
class ProjectGroupsTest {
    private val inputs = SessionListInputs(emptyList(), emptyMap())
    private val toRow = { s: Session -> buildSessionRowData(s, inputs) }
    private val isActive = { s: Session -> s.active }

    private fun rig(id: String, projectId: String? = null, projectName: String = "Repo", workspaceId: String? = null, workspaceName: String = "wt", active: Boolean = true) =
        session(id, rigMetadata(projectId = projectId, projectName = projectName, workspaceId = workspaceId, workspaceName = workspaceName), active = active)

    private fun happy(id: String, path: String, machineId: String = "machine-1", homeDir: String? = null, active: Boolean = true) =
        session(
            id,
            metadata(path) {
                put("machineId", machineId)
                homeDir?.let { put("homeDir", it) }
            },
            active = active,
        )

    @Test
    fun gathersEveryWorktreeOfARepoUnderOneProject() {
        val groups = buildProjectGroups(
            listOf(
                rig("a", "p1", projectName = "happy"),
                rig("b", "p1", workspaceId = "w1", workspaceName = "feature"),
                rig("c", "p1", workspaceId = "w2", workspaceName = "bugfix"),
            ),
            toRow, isActive,
        )
        assertEquals(1, groups.size)
        assertEquals("happy", groups[0].name)
        assertEquals(3, groups[0].sessionCount)
        assertEquals(listOf(null, "feature", "bugfix"), groups[0].workspaces.map { it.name })
    }

    @Test
    fun keepsSeparateProjectsApart() {
        val groups = buildProjectGroups(listOf(rig("a", "p1", "one"), rig("b", "p2", "two")), toRow, isActive)
        assertEquals(listOf("one", "two"), groups.map { it.name })
    }

    @Test
    fun putsThePrimaryTreeFirstEvenWhenAWorktreeSessionComesFirst() {
        val groups = buildProjectGroups(listOf(rig("a", "p1", workspaceId = "w1"), rig("b", "p1")), toRow, isActive)
        assertEquals(listOf("", "w1"), groups[0].workspaces.map { it.id })
    }

    @Test
    fun groupsSeveralSessionsInsideTheSameWorktree() {
        val groups = buildProjectGroups(listOf(rig("a", "p1", workspaceId = "w1"), rig("b", "p1", workspaceId = "w1")), toRow, isActive)
        assertEquals(1, groups[0].workspaces.size)
        assertEquals(listOf("a", "b"), groups[0].workspaces[0].sessions.map { it.id })
    }

    @Test
    fun countsActiveSessionsSeparatelyFromTheTotal() {
        val groups = buildProjectGroups(listOf(rig("a", "p1"), rig("b", "p1", active = false)), toRow, isActive)
        assertEquals(2, groups[0].sessionCount)
        assertEquals(1, groups[0].activeCount)
    }

    @Test
    fun carriesTheProjectIdentityOntoEachRow() {
        val row = buildProjectGroups(listOf(rig("a", "p1", "happy", "w1", "feature")), toRow, isActive)[0].workspaces[0].sessions[0]
        assertEquals("rig", row.clientId)
        assertEquals("p1", row.projectId)
        assertEquals("happy", row.projectName)
        assertEquals("w1", row.workspaceId)
        assertEquals("feature", row.workspaceName)
    }

    @Test
    fun groupsHappySessionsByMachineAndWorkingDirectory() {
        val groups = buildPathProjectGroups(
            listOf(happy("a", "/projects/happy"), happy("b", "/projects/happy", active = false)),
            toRow, isActive, "happy",
        )
        assertEquals(1, groups.size)
        assertEquals("happy", groups[0].name)
        assertEquals("machine-1", groups[0].machineId)
        assertEquals(2, groups[0].sessionCount)
        assertEquals(1, groups[0].activeCount)
        assertEquals(listOf("a", "b"), groups[0].workspaces[0].sessions.map { it.id })
        assertEquals("""happy:["machine-1","/projects/happy"]""", groups[0].id)
    }

    @Test
    fun doesNotMergeTheSamePathFromDifferentMachines() {
        val groups = buildPathProjectGroups(
            listOf(happy("a", "/projects/happy", "machine-1"), happy("b", "/projects/happy", "machine-2")),
            toRow, isActive, "happy",
        )
        assertEquals(listOf("machine-1", "machine-2"), groups.map { it.machineId })
        assertEquals(2, groups.map { it.id }.toSet().size)
    }

    @Test
    fun namesTheMachineHomeDirectoryHome() {
        val groups = buildPathProjectGroups(listOf(happy("a", "/Users/dev", homeDir = "/Users/dev/")), toRow, isActive, "happy")
        assertEquals("Home", groups[0].name)
    }

    @Test
    fun nestsHappyWorktreesUnderTheirRepositoryProject() {
        val groups = buildPathProjectGroups(
            listOf(happy("worktree", "/projects/happy/.dev/worktree/simpler-home"), happy("main", "/projects/happy")),
            toRow, isActive, "happy",
        )
        assertEquals(1, groups.size)
        assertEquals("happy", groups[0].name)
        val workspaces = groups[0].workspaces
        assertEquals(listOf("", "/projects/happy/.dev/worktree/simpler-home"), workspaces.map { it.id })
        assertEquals(listOf(null, "simpler-home"), workspaces.map { it.name })
        assertEquals(listOf(listOf("main"), listOf("worktree")), workspaces.map { w -> w.sessions.map { it.id } })
    }

    @Test
    fun keepsWorktreesWithTheSameNameSeparateAcrossRepositories() {
        val groups = buildPathProjectGroups(
            listOf(happy("happy", "/projects/happy/.dev/worktree/review"), happy("website", "/projects/website/.dev/worktree/review")),
            toRow, isActive, "happy",
        )
        assertEquals(listOf("happy", "website"), groups.map { it.name })
    }

    @Test
    fun hidesArchivedRowsInsideAProjectAndRefreshesItsCount() {
        val project = ProjectGroupData(
            "happy-project", "happy", "machine-1",
            listOf(ProjectWorkspaceGroup("", null, listOf(SessionRowData("active"), SessionRowData("archived", active = false, archived = true)))),
            2, 1,
        )
        val filtered = project.filterSessions { !it.archived }!!
        assertEquals(1, filtered.sessionCount)
        assertEquals(1, filtered.activeCount)
        assertEquals(listOf("active"), filtered.workspaces[0].sessions.map { it.id })
    }

    // A Rig session that dropped its connection is inactive but not archived.
    @Test
    fun keepsADisconnectedSessionThatWasNeverArchived() {
        val project = ProjectGroupData(
            "rig-project", "rig", "machine-1",
            listOf(
                ProjectWorkspaceGroup(
                    "", null,
                    listOf(SessionRowData("disconnected", active = false), SessionRowData("archived", active = false, archived = true)),
                ),
            ),
            2, 0,
        )
        val filtered = project.filterSessions { !it.archived }!!
        assertEquals(1, filtered.sessionCount)
        assertEquals(0, filtered.activeCount)
        assertEquals(listOf("disconnected"), filtered.workspaces[0].sessions.map { it.id })
    }
}
