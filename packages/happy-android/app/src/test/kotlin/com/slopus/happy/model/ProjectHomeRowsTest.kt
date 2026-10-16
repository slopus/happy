package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import java.time.LocalDate
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** utils/projectHomeList.test.ts: buildProjectHomeRows, findProjectWorktree and workspaceOrigin. */
class ProjectHomeRowsTest {
    private fun row(
        id: String,
        state: SessionState = SessionState.Waiting,
        createdAt: Long = 0,
        lastActivityAt: Long = 0,
        active: Boolean = true,
        machineId: String? = "machine-a",
        machineOffline: Boolean = false,
        path: String? = null,
        hasUnread: Boolean = false,
        projectId: String? = null,
        clientId: String = "rig",
    ) = SessionRowData(
        id = id,
        name = id,
        subtitle = "",
        clientId = clientId,
        state = state,
        createdAt = createdAt,
        lastActivityAt = lastActivityAt,
        active = active,
        machineId = machineId,
        machineOffline = machineOffline,
        path = path,
        hasUnread = hasUnread,
        projectId = projectId,
    )

    private fun ws(id: String, name: String?, vararg sessions: SessionRowData) = ProjectWorkspaceGroup(id, name, sessions.toList())

    private fun project(name: String, source: ProjectSource, workspaces: List<ProjectWorkspaceGroup>, machineId: String = "machine-a"): SessionListItem {
        val count = workspaces.sumOf { it.sessions.size }
        val prefix = if (source == ProjectSource.Rig) "rig" else "happy"
        return SessionListItem.ProjectItem(source, ProjectGroupData("$prefix:$name", name, machineId, workspaces, count, count))
    }

    private val machines = listOf(
        machine("machine-a", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") }),
        machine("machine-b", machineMetadata { put("displayName", "Laptop"); put("machineKind", "rig") }),
        // No `machineKind`: a Happy CLI daemon, which trails the Happy Agent ones.
        machine("machine-c", machineMetadata { put("displayName", "Terminal") }),
    ).associateBy { it.id }

    private fun build(data: List<SessionListItem>, expanded: Set<String> = emptySet(), hasArchivedSessions: Boolean = false, archiveHidden: Boolean = true) =
        buildProjectHomeRows(data, machines, "unknown", expanded, hasArchivedSessions, archiveHidden)

    private fun shape(rows: List<ProjectHomeRow>): List<String> = rows.map { item ->
        when (item) {
            is ProjectHomeRow.Section -> "section:${if (item.section == ProjectHomeSection.Bots) "Bots" else "Projects"}"
            is ProjectHomeRow.MachineHeader -> "machine:${item.machineName}"
            is ProjectHomeRow.Bot -> "bot:${item.session.id}"
            is ProjectHomeRow.ProjectCard -> "project:${item.project.name}(${item.project.worktreeCount})"
            is ProjectHomeRow.Worktree -> "worktree:${item.worktree.workspaceName}${if (item.last) ":last" else ""}"
            is ProjectHomeRow.Toggle -> if (item.toggle.expanded) "toggle:less" else "toggle:+${item.toggle.hiddenCount}"
            is ProjectHomeRow.ArchiveToggle -> if (item.hidden) "archive:show" else "archive:hide"
            is ProjectHomeRow.ArchiveHeader -> "archiveHeader:${item.title}"
            is ProjectHomeRow.Archived -> "archived:${item.session.id}"
        }
    }

    /** `count` worktrees named w1, w2, … beside the project's own checkout. */
    private fun worktrees(count: Int) = listOf(ws("", null, row("own"))) +
        (1..count).map { ws("w$it", "w$it", row("s$it")) }

    private fun card(row: ProjectHomeRow) = (row as ProjectHomeRow.ProjectCard).project
    private fun worktree(row: ProjectHomeRow) = (row as ProjectHomeRow.Worktree).worktree
    private fun toggle(row: ProjectHomeRow) = (row as ProjectHomeRow.Toggle).toggle

    private val ownOnly = listOf(ws("", null, row("a")))

    @Test fun projectIsItsOwnCardWithOnlyWorktreesUnderIt() {
        val rows = build(listOf(project("happy", ProjectSource.Rig, listOf(ws("", null, row("a"), row("b")), ws("gdansk", "Gdansk", row("c"))))))
        assertEquals(listOf("machine:Studio", "section:Projects", "project:happy(1)", "worktree:Gdansk:last"), shape(rows))
    }

    @Test fun projectWithNoWorktreesHasASingleCard() {
        val rows = build(listOf(project("shop-box", ProjectSource.Rig, ownOnly)))
        assertEquals(listOf("machine:Studio", "section:Projects", "project:shop-box(0)"), shape(rows))
        assertEquals(0, card(rows[2]).worktreeCount)
    }

    @Test fun cardOpensOwnCheckoutWithTabsOldestFirst() {
        // The store hands a checkout's chats over most recent first.
        val rows = build(listOf(project("happy", ProjectSource.Rig, listOf(ws("", null, row("late", createdAt = 20), row("early", createdAt = 10))))))
        assertEquals("late", card(rows[2]).session?.id)
        assertEquals(listOf("early", "late"), card(rows[2]).tabs.map { it.id })
    }

    @Test fun treeLineClosesOnTheLastWorktreeOnly() {
        val rows = build(listOf(project("happy", ProjectSource.Rig, listOf(ws("", null, row("a")), ws("v", "Vilnius", row("b")), ws("i", "Istanbul", row("c"))))))
        assertEquals(
            listOf("machine:Studio", "section:Projects", "project:happy(2)", "worktree:Vilnius", "worktree:Istanbul:last"),
            shape(rows),
        )
    }

    @Test fun eachWorktreeReportsItsOwnChatsAndTheCardOnlyItsOwn() {
        val rows = build(listOf(project("happy", ProjectSource.Rig, listOf(
            ws("", null, row("a")),
            ws("w", "w", row("b", state = SessionState.PermissionRequired, hasUnread = true)),
        ))))
        card(rows[2]).let { assertFalse(it.working); assertFalse(it.blocked); assertFalse(it.unread) }
        worktree(rows[3]).let { assertTrue(it.blocked); assertTrue(it.unread) }
    }

    @Test fun showsTheFirstThreeWorktreesAndOffersTheRest() {
        assertEquals(
            listOf("machine:Studio", "section:Projects", "project:happy(5)", "worktree:w1", "worktree:w2", "worktree:w3", "toggle:+2"),
            shape(build(listOf(project("happy", ProjectSource.Rig, worktrees(5))))),
        )
    }

    @Test fun showsEveryWorktreeOnceExpanded() {
        assertEquals(
            listOf(
                "machine:Studio", "section:Projects", "project:happy(5)",
                "worktree:w1", "worktree:w2", "worktree:w3", "worktree:w4", "worktree:w5", "toggle:less",
            ),
            shape(build(listOf(project("happy", ProjectSource.Rig, worktrees(5))), setOf("rig:happy"))),
        )
    }

    @Test fun projectAtThePreviewCountHasNoToggle() {
        // Three shown and none held back: a control that would do nothing in
        // either direction is not drawn.
        val expected = listOf("machine:Studio", "section:Projects", "project:happy(3)", "worktree:w1", "worktree:w2", "worktree:w3:last")
        assertEquals(expected, shape(build(listOf(project("happy", ProjectSource.Rig, worktrees(3))))))
        assertEquals(expected, shape(build(listOf(project("happy", ProjectSource.Rig, worktrees(3))), setOf("rig:happy"))))
    }

    @Test fun toggleSpeaksForHeldBackWorktreesAndForNothingOnceExpanded() {
        val held = listOf(ws("", null, row("own"))) +
            (1..3).map { ws("w$it", "w$it", row("s$it")) } +
            ws("w4", "w4", row("s4", state = SessionState.PermissionRequired, hasUnread = true))

        val folded = build(listOf(project("happy", ProjectSource.Rig, held)))
        toggle(folded[6]).let { assertEquals(1, it.hiddenCount); assertTrue(it.blocked); assertTrue(it.unread) }
        // The card never took this on: it answers for its own checkout only.
        card(folded[2]).let { assertFalse(it.blocked); assertFalse(it.unread) }

        val open = build(listOf(project("happy", ProjectSource.Rig, held)), setOf("rig:happy"))
        toggle(open[7]).let {
            assertTrue(it.expanded)
            assertEquals(0, it.hiddenCount)
            assertFalse(it.blocked)
            assertFalse(it.unread)
        }
    }

    @Test fun treeLineRunsThroughTheToggle() {
        val rows = build(listOf(project("happy", ProjectSource.Rig, worktrees(4))))
        assertFalse((rows[5] as ProjectHomeRow.Worktree).last)
        assertTrue(rows[6] is ProjectHomeRow.Toggle)
    }

    @Test fun projectWithOnlyWorktreesHasNoChatOnTheCard() {
        val rows = build(listOf(project("happy", ProjectSource.Rig, listOf(ws("w", "Vilnius", row("a"))))))
        assertEquals(listOf("machine:Studio", "section:Projects", "project:happy(1)", "worktree:Vilnius:last"), shape(rows))
        assertNull(card(rows[2]).session)
        assertEquals("a", card(rows[2]).avatarSession?.id)
    }

    @Test fun cardIsLiveOnlyWhileAChatRunsOnAReachableMachine() {
        val offline = build(listOf(project("a", ProjectSource.Rig, listOf(ws("", null, row("x", machineOffline = true))))))
        val inactive = build(listOf(project("b", ProjectSource.Rig, listOf(ws("", null, row("y", active = false))))))
        val live = build(listOf(project("c", ProjectSource.Rig, listOf(ws("", null, row("z"))))))
        assertFalse(card(offline[2]).live)
        assertFalse(card(inactive[2]).live)
        assertTrue(card(live[2]).live)
    }

    @Test fun skipsEmptyCheckoutsAndEmptyProjects() {
        val rows = build(listOf(
            project("happy", ProjectSource.Rig, listOf(ws("", null), ws("w", "w", row("a")))),
            project("empty", ProjectSource.Rig, listOf(ws("", null))),
        ))
        assertEquals(listOf("machine:Studio", "section:Projects", "project:happy(1)", "worktree:w:last"), shape(rows))
    }

    @Test fun cliProjectsGetTheSameCards() {
        val rows = build(listOf(
            SessionListItem.Bots(listOf(row("bot"), row("cli-bot", clientId = "happy-cli"))),
            project("happy", ProjectSource.Rig, ownOnly),
            project("cli", ProjectSource.Happy, listOf(ws("", null, row("b", clientId = "happy-cli")))),
        ))
        assertEquals(
            listOf("machine:Studio", "section:Bots", "bot:bot", "bot:cli-bot", "section:Projects", "project:cli(0)", "project:happy(0)"),
            shape(rows),
        )
    }

    @Test fun headsTheListWithTheComputerEvenForOne() {
        assertEquals(
            listOf("machine:Studio", "section:Projects", "project:happy(0)"),
            shape(build(listOf(project("happy", ProjectSource.Rig, ownOnly)))),
        )
    }

    @Test fun everyComputerHasItsOwnBotsAndProjects() {
        val rows = build(listOf(
            SessionListItem.Bots(listOf(row("studio-bot"), row("terminal-bot", machineId = "machine-c"))),
            project("happy", ProjectSource.Rig, ownOnly),
            project("cli", ProjectSource.Happy, listOf(ws("", null, row("b", machineId = "machine-c"))), "machine-c"),
        ))
        assertEquals(
            listOf(
                "machine:Studio", "section:Bots", "bot:studio-bot", "section:Projects", "project:happy(0)",
                "machine:Terminal", "section:Bots", "bot:terminal-bot", "section:Projects", "project:cli(0)",
            ),
            shape(rows),
        )
    }

    @Test fun happyAgentComputersLeadAndCliDaemonsTrail() {
        val rows = build(listOf(
            project("cli", ProjectSource.Happy, listOf(ws("", null, row("a", machineId = "machine-c"))), "machine-c"),
            project("agent", ProjectSource.Rig, listOf(ws("", null, row("b")))),
        ))
        assertEquals(listOf("machine:Studio", "machine:Terminal"), shape(rows).filter { it.startsWith("machine:") })
    }

    @Test fun mostRecentlyWorkedOnComputerFirstWithinItsKind() {
        // Laptop sorts before Studio by name, so leading with Studio can only
        // be its more recent activity.
        val rows = build(listOf(
            project("recent", ProjectSource.Rig, listOf(ws("", null, row("a", lastActivityAt = 20)))),
            project("stale", ProjectSource.Rig, listOf(ws("", null, row("b", machineId = "machine-b", lastActivityAt = 10))), "machine-b"),
        ))
        assertEquals(listOf("machine:Studio", "machine:Laptop"), shape(rows).filter { it.startsWith("machine:") })
    }

    @Test fun chatWithNoComputerIsFiledLastUnderItsOwnHeading() {
        val rows = build(listOf(
            SessionListItem.Bots(listOf(row("homeless", machineId = null))),
            project("happy", ProjectSource.Rig, ownOnly),
        ))
        assertEquals(
            listOf("machine:Studio", "section:Projects", "project:happy(0)", "machine:<unknown>", "section:Bots", "bot:homeless"),
            shape(rows),
        )
    }

    // Repeated labels are repeated rows, and the list keys on the id.
    @Test fun sectionLabelsUnderEachComputerHaveIdsOfTheirOwn() {
        val rows = build(listOf(SessionListItem.Bots(listOf(row("studio-bot"), row("terminal-bot", machineId = "machine-c")))))
        assertEquals(listOf("bots:machine-a", "bots:machine-c"), rows.filterIsInstance<ProjectHomeRow.Section>().map { it.id })
        assertEquals(rows.size, rows.map { it.key }.toSet().size)
    }

    @Test fun revealedArchiveTrailsBehindEveryComputer() {
        val rows = build(
            listOf(
                project("happy", ProjectSource.Rig, ownOnly),
                SessionListItem.Header(DayTitle.Today, LocalDate.of(2026, 10, 16)),
                SessionListItem.SessionItem(row("archived").copy(archived = true)),
            ),
            hasArchivedSessions = true,
            archiveHidden = false,
        )
        assertEquals(
            listOf("machine:Studio", "section:Projects", "project:happy(0)", "archive:hide", "archiveHeader:Today", "archived:archived"),
            shape(rows),
        )
    }

    // The store filters hidden archived chats out before they get here, so the
    // toggle is the only trace of them, and nothing else could bring them back.
    @Test fun hiddenArchiveKeepsOnlyItsToggle() {
        val rows = build(listOf(project("happy", ProjectSource.Rig, ownOnly)), hasArchivedSessions = true, archiveHidden = true)
        assertEquals(listOf("machine:Studio", "section:Projects", "project:happy(0)", "archive:show"), shape(rows))
    }

    // An account with nothing but an archive used to open onto a blank screen.
    @Test fun offersTheArchiveWhenThereIsNothingElse() {
        assertEquals(listOf("archive:show"), shape(build(emptyList(), hasArchivedSessions = true, archiveHidden = true)))
    }

    @Test fun noToggleWithoutArchivedChats() {
        assertEquals(
            listOf("machine:Studio", "section:Projects", "project:happy(0)"),
            shape(build(listOf(project("happy", ProjectSource.Rig, ownOnly)))),
        )
    }

    @Test fun noProjectsHeadingWithoutProjects() {
        assertEquals(listOf("machine:Studio", "section:Bots", "bot:bot"), shape(build(listOf(SessionListItem.Bots(listOf(row("bot")))))))
        assertEquals(emptyList<ProjectHomeRow>(), build(emptyList()))
    }

    private val worktreeData = listOf(
        SessionListItem.Bots(listOf(row("bot"))),
        project("happy", ProjectSource.Rig, listOf(ws("", null, row("own")), ws("gdansk", "Gdansk", row("b", createdAt = 2), row("a", createdAt = 1)))),
        project("cli", ProjectSource.Happy, listOf(ws("", null, row("cli", clientId = "happy-cli")))),
    )

    @Test fun findsTheCheckoutAChatRunsInWithSiblingTabs() {
        val found = findProjectWorktree(worktreeData, "a")!!
        assertEquals("happy", found.projectName)
        assertEquals("gdansk", found.workspaceId)
        assertEquals("Gdansk", found.workspaceName)
        assertEquals(listOf("a", "b"), found.tabs.map { it.id })
        findProjectWorktree(worktreeData, "own")!!.let { assertEquals("", it.workspaceId); assertNull(it.workspaceName) }
    }

    @Test fun findsCliProjectChats() {
        findProjectWorktree(worktreeData, "cli")!!.let { assertEquals("cli", it.projectName); assertEquals("", it.workspaceId) }
    }

    @Test fun findsNothingForBotsOrUnknownChats() {
        assertNull(findProjectWorktree(worktreeData, "bot"))
        assertNull(findProjectWorktree(worktreeData, "missing"))
        assertNull(findProjectWorktree(null, "a"))
    }

    @Test fun workspaceOriginNamesAHappyAgentProjectByIdentity() {
        assertEquals(
            WorkspaceOrigin("machine-a", "project-1", null),
            workspaceOrigin(row("a", projectId = "project-1", path = "/repo/.dev/worktree/gdansk")),
        )
    }

    @Test fun workspaceOriginSendsACliWorktreeBackToItsMainCheckout() {
        assertEquals(WorkspaceOrigin("machine-a", null, "/repo"), workspaceOrigin(row("a", path = "/repo/.dev/worktree/gdansk")))
        assertEquals(WorkspaceOrigin("machine-a", null, "/repo"), workspaceOrigin(row("a", path = "/repo")))
    }

    @Test fun workspaceOriginNeedsAMachineAndAPlace() {
        assertNull(workspaceOrigin(row("a", path = "/repo", machineId = null)))
        assertNull(workspaceOrigin(row("a", path = null)))
        assertNull(workspaceOrigin(row("a", path = "   ")))
    }

    @Test fun compactCountsLikeHappyDesktop() {
        assertEquals("999", compactCount(999))
        assertEquals("1k", compactCount(1_000))
        assertEquals("1.2k", compactCount(1_234))
        assertEquals("5k", compactCount(4_960))
        assertEquals("12k", compactCount(12_345))
        assertEquals("0", compactCount(-3))
    }

    /** ProjectHomeList useGitChanges: Happy Agent's counts first, the daemon's working tree only without them. */
    @Test fun theCheckoutsLineCountsPreferHappyAgentsComparison() {
        val live = SessionRowData("a", gitStatusLinesAdded = 5, gitStatusLinesRemoved = 2)
        assertEquals(VisibleGitChanges(false, 5, 2), projectGitChanges(live))
        val rig = live.copy(gitChangedFiles = 1, gitInsertions = 9, gitDeletions = 0, gitCountsExact = false)
        assertEquals(VisibleGitChanges(true, 9, 0), projectGitChanges(rig))
        assertNull("a clean Happy Agent comparison hides the daemon's", projectGitChanges(rig.copy(gitInsertions = 0)))
        assertNull(projectGitChanges(SessionRowData("b")))
        assertNull("the flat row reads Happy Agent's only", visibleGitChanges(live))
    }

    @Test fun aRowCarriesItsCheckoutsStatus() {
        val sessions = listOf(HomeModelFixtures.session("a", HomeModelFixtures.metadata("/repo") { put("machineId", "m1") }))
        val status = parseGitStatus("", "4\t1\tx.ts", "1\t0\ty.ts", 0)
        val row = buildSessionRowData(sessions[0], SessionListInputs(sessions, emptyMap(), gitStatuses = mapOf("m1:/repo" to status)))
        assertEquals(5L, row.gitStatusLinesAdded)
        assertEquals(1L, row.gitStatusLinesRemoved)
        val elsewhere = buildSessionRowData(sessions[0], SessionListInputs(sessions, emptyMap(), gitStatuses = mapOf("m2:/repo" to status)))
        assertEquals(0L, elsewhere.gitStatusLinesAdded)
    }
}
