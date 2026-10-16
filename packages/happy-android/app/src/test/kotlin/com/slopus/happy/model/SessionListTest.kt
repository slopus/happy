package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.sync.ForkSource
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * utils/flatSessionList.test.ts, utils/flatSessionRowPresentation.test.ts,
 * utils/sessionActivity.test.ts, sync/resolveSessionAvatar.test.ts,
 * sync/sessionIdentity.test.ts, utils/avatarHarness.test.ts,
 * utils/sessionFork.test.ts, and storage.ts's list building.
 */
class SessionListTest {
    private fun project(name: String, vararg workspaces: ProjectWorkspaceGroup) = SessionListItem.ProjectItem(
        ProjectSource.Happy,
        ProjectGroupData(name, name, "machine", workspaces.toList(), workspaces.sumOf { it.sessions.size }, 0),
    )

    // flatSessionList.test.ts

    @Test
    fun showsOnlyTheBotIdentityAndOmitsItsMachineLabel() {
        val rows = buildFlatSessionRows(
            listOf(
                SessionListItem.Bots(
                    listOf(
                        SessionRowData("laptop-bot", name = "Assistant", botId = "bot-1", botUsername = "assistant", machineId = "laptop", machineName = "My Laptop"),
                        SessionRowData("desktop-bot", name = "Assistant", botId = "bot-2", botUsername = "assistant", machineId = "desktop", machineName = "Office Mac"),
                    ),
                ),
            ),
            sortByActivity = true,
        )
        assertEquals(listOf("@assistant", "@assistant"), rows.map { it.projectName })
        assertTrue(rows.all { it.workspaceName == null })
    }

    @Test
    fun includesBotRowsInRecencyOrderWithoutInventingAProject() {
        val bot = SessionRowData("bot-session", lastActivityAt = 200, botId = "bot-1", botUsername = "assistant", path = "/home/steve/Happy/Bots/assistant")
        val rows = buildFlatSessionRows(
            listOf(SessionListItem.Bots(listOf(bot)), project("alpha", ProjectWorkspaceGroup("", null, listOf(SessionRowData("chat", lastActivityAt = 100))))),
            sortByActivity = true,
        )
        assertEquals(listOf("bot-session", "chat"), rows.map { it.session.id })
        assertEquals("@assistant", rows[0].projectName)
        assertNull(rows[0].workspaceName)
    }

    @Test
    fun namesTheProjectAndWorktreeEachSessionBelongsTo() {
        val rows = buildFlatSessionRows(
            listOf(
                project(
                    "happy",
                    ProjectWorkspaceGroup("", null, listOf(SessionRowData("primary"))),
                    ProjectWorkspaceGroup("/wt/innsbruck", "innsbruck", listOf(SessionRowData("worktree"))),
                ),
            ),
            sortByActivity = true,
        )
        assertEquals(listOf(Triple("primary", "happy", null), Triple("worktree", "happy", "innsbruck")), rows.map { Triple(it.session.id, it.projectName, it.workspaceName) })
    }

    @Test
    fun fallsBackToTheWorktreePathWhenTheGroupHasNoName() {
        val rows = buildFlatSessionRows(listOf(project("happy", ProjectWorkspaceGroup("/wt/innsbruck", null, listOf(SessionRowData("a"))))), true)
        assertEquals("/wt/innsbruck", rows[0].workspaceName)
    }

    @Test
    fun restoresGlobalRecencyAcrossProjectsActiveSessionsFirst() {
        val rows = buildFlatSessionRows(
            listOf(
                project("alpha", ProjectWorkspaceGroup("", null, listOf(SessionRowData("alpha-new", lastActivityAt = 300), SessionRowData("alpha-old", lastActivityAt = 100)))),
                project("beta", ProjectWorkspaceGroup("", null, listOf(SessionRowData("beta-mid", lastActivityAt = 200), SessionRowData("beta-dead", lastActivityAt = 400, active = false)))),
            ),
            sortByActivity = true,
        )
        assertEquals(listOf("alpha-new", "beta-mid", "alpha-old", "beta-dead"), rows.map { it.session.id })
    }

    @Test
    fun sortsOnCreationDateWhenActivitySortingIsOff() {
        val rows = buildFlatSessionRows(
            listOf(
                project(
                    "alpha",
                    ProjectWorkspaceGroup(
                        "", null,
                        listOf(SessionRowData("older-but-active-recently", createdAt = 1, lastActivityAt = 900), SessionRowData("newer", createdAt = 5, lastActivityAt = 5)),
                    ),
                ),
            ),
            sortByActivity = false,
        )
        assertEquals(listOf("newer", "older-but-active-recently"), rows.map { it.session.id })
    }

    @Test
    fun ignoresArchivedRowsAndHeadingsWhichStayASeparateTail() {
        val rows = buildFlatSessionRows(
            listOf(
                SessionListItem.Header(DayTitle.Today, LocalDate.of(2026, 1, 1)),
                SessionListItem.SessionItem(SessionRowData("archived", archived = true)),
                SessionListItem.ProjectsHeader(ProjectSource.Happy),
                project("alpha", ProjectWorkspaceGroup("", null, listOf(SessionRowData("live")))),
            ),
            sortByActivity = true,
        )
        assertEquals(listOf("live"), rows.map { it.session.id })
    }

    @Test
    fun placesAnArchivedWorktreeRowByItsPath() {
        val row = toFlatSessionRow(SessionRowData("a", path = "/projects/happy/.dev/worktree/review"))
        assertEquals("happy", row.projectName)
        assertEquals("review", row.workspaceName)
    }

    // flatSessionRowPresentation.test.ts

    @Test
    fun rowPresentation() {
        assertEquals(FlatRowPresentation(true, FlatRowTopRight.Timestamp), resolveFlatRowPresentation(SessionState.Thinking, hasUnread = false, faded = false))
        assertEquals(FlatRowPresentation(false, FlatRowTopRight.Dot(blocked = false)), resolveFlatRowPresentation(SessionState.Waiting, hasUnread = true, faded = false))
        for (state in listOf(SessionState.PermissionRequired, SessionState.InputRequired)) {
            assertEquals(FlatRowPresentation(false, FlatRowTopRight.Dot(blocked = true)), resolveFlatRowPresentation(state, hasUnread = true, faded = false))
        }
        assertEquals(FlatRowTopRight.Timestamp, resolveFlatRowPresentation(SessionState.Waiting, hasUnread = false, faded = false).topRight)
        assertEquals(FlatRowPresentation(false, FlatRowTopRight.Timestamp), resolveFlatRowPresentation(SessionState.PermissionRequired, hasUnread = true, faded = true))
    }

    // sessionActivity.test.ts

    @Test
    fun activityPrefersThePublishedTimestampThenTheLocalSendThenCreation() {
        val published = metadata { put("lastMeaningfulMessageAt", 900) }
        assertEquals(900L, session("s", published, createdAt = 100, lastMessageSentAt = 300).activityAt())
        assertEquals(300L, session("s", metadata(), createdAt = 100, lastMessageSentAt = 300).activityAt())
        assertEquals(100L, session("s", null, createdAt = 100).activityAt())
        val older = metadata { put("lastMeaningfulMessageAt", 200) }
        assertEquals(200L, session("s", older, createdAt = 100, lastMessageSentAt = 800).activityAt())
    }

    // resolveSessionAvatar.test.ts

    @Test
    fun sessionAvatarPrecedence() {
        val projectImage = ProjectAvatar("p", 1, "image/png", "", "project")
        val sessionImage = ProjectAvatar("s", 1, "image/png", "", "session")
        val projects = mapOf("p" to Project("p", "p", "P", null, 0, projectImage, 0, 0))
        val base = session("x", rigMetadata(), projectId = "p")
        assertSame(sessionImage, base.copy(avatar = sessionImage).resolveAvatar(projects))
        assertSame(projectImage, base.resolveAvatar(projects))
        assertSame(sessionImage, base.copy(projectId = null, avatar = sessionImage).resolveAvatar(projects))
        assertNull(base.copy(projectId = null).resolveAvatar(projects))
        // Only Happy Agent sessions may use private project artwork.
        assertNull(session("y", metadata(), projectId = "p").resolveAvatar(projects))
    }

    // sessionIdentity.test.ts

    @Test
    fun keepsSessionsFromMultipleDaemonsDistinct() {
        data class Row(val id: String, val machineId: String, val daemon: String)
        val indexed = indexSessionsById(listOf(Row("native-session", "same-machine", "happy"), Row("rig-session", "same-machine", "rig"))) { it.id }
        assertEquals(listOf("native-session", "rig-session"), indexed.keys.toList())
        assertEquals("happy", indexed.getValue("native-session").daemon)
        assertEquals("rig", indexed.getValue("rig-session").daemon)
    }

    // avatarHarness.test.ts

    @Test
    fun avatarHarness() {
        assertEquals(AvatarHarness.Claude, resolveAvatarHarness("claude", null))
        assertEquals(AvatarHarness.Codex, resolveAvatarHarness("codex", null))
        assertEquals(AvatarHarness.Agy, resolveAvatarHarness("agy", null))
        assertEquals(AvatarHarness.Rig, resolveAvatarHarness("codex", "rig"))
        assertEquals(AvatarHarness.Rig, resolveAvatarHarness(null, "rig"))
        for (flavor in listOf("gemini", "openclaw", "future-harness", null)) assertNull(resolveAvatarHarness(flavor, null))
        assertNull(resolveAvatarHarness(null, "other-client"))
    }

    // sessionFork.test.ts

    @Test
    fun forkSources() {
        val claude = session("happy-claude", metadata("/tmp/project") {
            put("flavor", "claude")
            put("machineId", "machine-1")
            put("claudeSessionId", "93a9705e")
        })
        assertEquals(ForkSource.Claude("happy-claude", "machine-1", "/tmp/project", "93a9705e"), claude.forkSource())
        val codex = session("happy-codex", metadata("/tmp/project") {
            put("flavor", "codex")
            put("machineId", "machine-1")
            put("codexThreadId", "019ccca5")
        })
        assertEquals(ForkSource.Codex("happy-codex", "machine-1", "/tmp/project", "019ccca5"), codex.forkSource())
        val missing = session("missing", metadata("/tmp/project") {
            put("flavor", "codex")
            put("machineId", "machine-1")
        })
        assertNull(missing.forkSource())
    }

    // sessionUtils.ts

    @Test
    fun namesSubtitlesAndAvatarIds() {
        val summary = metadata("/Users/dev/happy") {
            put("homeDir", "/Users/dev/")
            put("machineId", "m1")
            putJsonObject("summary") {
                put("text", "Fix the list")
                put("updatedAt", 1)
            }
        }
        val s = session("s1", summary)
        assertEquals("Fix the list", s.displayName())
        assertEquals("~/happy", s.displaySubtitle())
        assertEquals("m1:/Users/dev/happy", s.avatarId())
        assertNull(session("s2", metadata()).displayName())
        assertEquals("s3", session("s3", null).avatarId())
        assertEquals("~", formatPathRelativeToHome("/Users/dev", "/Users/dev"))
        assertEquals("/opt/x", formatPathRelativeToHome("/opt/x", "/Users/dev"))
        assertEquals("macOS", formatOSPlatform("darwin"))
        assertEquals("plan9", formatOSPlatform("plan9"))
    }

    // storage.ts buildSessionListViewData

    private val zone: ZoneId = ZoneOffset.UTC
    private val today = LocalDate.of(2026, 8, 23)
    private fun at(day: LocalDate, hour: Int = 12) = day.atTime(hour, 0).toInstant(ZoneOffset.UTC).toEpochMilli()

    @Test
    fun buildsBotsRigProjectsHappyProjectsThenTheArchiveByDay() {
        val sessions = listOf(
            session("happy-live", metadata("/projects/happy") { put("machineId", "m1") }),
            session("rig-live", rigMetadata(projectId = "p1", projectName = "rigproj")),
            session("bot-b", rigMetadata(extra = { botJson("b2", "2") })),
            session("bot-a", rigMetadata(extra = { botJson("b1", "1") })),
            session("side", metadata { put("isSideChat", true) }),
            session("ended-today", metadata { put("lastMeaningfulMessageAt", at(today)) }, active = false),
            session("ended-yesterday", metadata { put("lastMeaningfulMessageAt", at(today.minusDays(1))) }, active = false),
            session("retired", rigMetadata(extra = {
                put("lifecycleState", "archived")
                put("lastMeaningfulMessageAt", at(today.minusDays(3)))
            }), active = false),
            session("rig-disconnected", rigMetadata(projectId = "p1"), active = false),
        )
        val items = buildSessionListViewData(SessionListInputs(sessions, emptyMap()), zone, today)
        val shape = items.map {
            when (it) {
                is SessionListItem.Bots -> "bots:" + it.sessions.joinToString(",") { r -> r.id }
                is SessionListItem.ProjectsHeader -> "header:${it.source}"
                is SessionListItem.ProjectItem -> "project:${it.project.name}:" + it.project.workspaces.flatMap { w -> w.sessions }.joinToString(",") { r -> r.id }
                is SessionListItem.Header -> "day:${it.title}"
                is SessionListItem.SessionItem -> "archived:${it.session.id}"
            }
        }
        assertEquals(
            listOf(
                "bots:bot-a,bot-b",
                "header:Rig",
                "project:rigproj:rig-live,rig-disconnected",
                "header:Happy",
                "project:happy:happy-live",
                "day:Today",
                "archived:ended-today",
                "day:Yesterday",
                "archived:ended-yesterday",
                "day:DaysAgo(days=3)",
                "archived:retired",
            ),
            shape,
        )
    }

    @Test
    fun archivingOnThisDeviceMovesTheRowAtOnce() {
        val sessions = listOf(session("a", metadata("/p") { put("machineId", "m") }))
        val items = buildSessionListViewData(SessionListInputs(sessions, emptyMap(), archivingSessionIds = setOf("a")), zone, today)
        assertTrue(items.last() is SessionListItem.SessionItem)
        assertTrue((items.last() as SessionListItem.SessionItem).session.archived)
    }

    @Test
    fun rowsGreyOutOnlyForAKnownOfflineMachine() {
        val sessions = listOf(
            session("on-offline", metadata { put("machineId", "off") }),
            session("on-unknown", metadata { put("machineId", "nowhere") }),
        )
        val machines = mapOf("off" to machine("off", active = false))
        val rows = sessions.map { buildSessionRowData(it, SessionListInputs(sessions, machines)) }
        assertTrue(rows[0].machineOffline)
        assertEquals("laptop.local", rows[0].machineName)
        assertFalse(rows[1].machineOffline)
        assertEquals("localhost", rows[1].machineName)
    }

    @Test
    fun hidingTheArchiveDropsEmptyHeadingsAndProjects() {
        val day = LocalDate.of(2026, 1, 1)
        val items = listOf(
            SessionListItem.ProjectsHeader(ProjectSource.Happy),
            project("only-archived", ProjectWorkspaceGroup("", null, listOf(SessionRowData("x", archived = true)))),
            SessionListItem.Header(DayTitle.Today, day),
            SessionListItem.SessionItem(SessionRowData("old", archived = true)),
        )
        assertEquals(emptyList<SessionListItem>(), visibleSessionListItems(items, hideArchived = true))
        assertEquals(items, visibleSessionListItems(items, hideArchived = false))
        assertTrue(hasArchivedSessions(items))
        assertFalse(hasArchivedSessions(listOf(project("p", ProjectWorkspaceGroup("", null, listOf(SessionRowData("y")))))))
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.botJson(id: String, orderKey: String) = putJsonObject("bot") {
        put("id", id)
        put("name", "Bot $id")
        put("username", id)
        put("workspaceId", "w")
        put("orderKey", orderKey)
    }
}
