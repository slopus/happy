package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.sync.HappyAgentSpawnTarget
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * agentSessionPlaces.spec.ts, happyAgentSpawn.test.ts and
 * newSessionProgress.test.ts, plus persistence.ts's draft round trip and
 * pathUtils' resolveAbsolutePath.
 */
class NewSessionTest {
    private val rig = "rig-machine"
    private val cli = "cli-machine"
    private var next = 0

    private fun place(
        machineId: String,
        path: String,
        archived: Boolean = false,
        project: Pair<String, String>? = null,
        workspace: Pair<String, String>? = null,
        bot: Boolean = false,
    ) = session(
        "s${next++}",
        metadata = metadata(path = path) {
            put("machineId", machineId)
            if (archived) put("lifecycleState", "archived")
            project?.let { (id, name) ->
                putJsonObject("project") { put("id", id); put("kind", "regular"); put("name", name) }
            }
            workspace?.let { (id, name) ->
                putJsonObject("workspace") { put("id", id); put("kind", "worktree"); put("name", name) }
            }
            if (bot) {
                putJsonObject("bot") {
                    put("id", "bot-1")
                    put("name", "Assistant")
                    put("username", "assistant")
                    put("workspaceId", "bot-ws")
                    put("orderKey", "1")
                    put("systemKey", JsonNull)
                }
            }
        },
    )

    @Test fun neverOffersABotFolderForASecondConversation() {
        val path = "/home/steve/Happy/Bots/assistant"
        assertEquals(emptyList<SessionPlace>(), collectSessionPlaces(listOf(rig), listOf(place(rig, path, bot = true))))
        val botInWorkspace = place(rig, path, project = "old-synthetic-project" to "Assistant", workspace = "bot-ws" to "Assistant", bot = true)
        assertEquals(emptyList<SessionWorkspace>(), collectSessionWorkspaces(listOf(rig), "old-synthetic-project", listOf(botInWorkspace)))
    }

    @Test fun offersTheDirectoriesLegacySessionsEstablishedOnEitherMachineOfThePair() {
        val places = collectSessionPlaces(
            listOf(rig, cli),
            listOf(place(cli, "/home/steve/projects/happy"), place(rig, "/home/steve/projects/rig")),
        )
        assertEquals(listOf("/home/steve/projects/happy", "/home/steve/projects/rig"), places.map { it.path }.sortedBy { it })
    }

    @Test fun prefersTheProjectNameHappyAgentKnowsOverTheBarePath() {
        val places = collectSessionPlaces(
            listOf(rig, cli),
            listOf(place(cli, "/home/steve/projects/rig"), place(rig, "/home/steve/projects/rig", project = "project-7" to "rig")),
        )
        assertEquals(1, places.size)
        assertEquals("rig" to "project-7", places[0].name to places[0].projectId)
    }

    @Test fun doesNotLetABarePathOverwriteANameAlreadyKnown() {
        val places = collectSessionPlaces(
            listOf(rig, cli),
            listOf(place(rig, "/home/steve/projects/rig", project = "project-7" to "rig"), place(cli, "/home/steve/projects/rig")),
        )
        assertEquals("rig" to "project-7", places[0].name to places[0].projectId)
    }

    @Test fun leavesOutArchivedSessionsWhoseCheckoutsMayBeGone() {
        val places = collectSessionPlaces(listOf(rig), listOf(place(rig, "/home/steve/old", archived = true), place(rig, "/home/steve/live")))
        assertEquals(listOf("/home/steve/live"), places.map { it.path })
    }

    @Test fun ignoresMachinesThatAreNotPartOfThisComputer() {
        assertEquals(emptyList<SessionPlace>(), collectSessionPlaces(listOf(rig), listOf(place("someone-elses-laptop", "/home/steve/x"))))
    }

    @Test fun alwaysOffersWhateverIsCurrentlySelected() {
        assertEquals(listOf("~"), collectSessionPlaces(listOf(rig), emptyList(), selectedPath = "~").map { it.path })
    }

    @Test fun keepsAWorkspaceOutOfTheProjectList() {
        val places = collectSessionPlaces(
            listOf(rig),
            listOf(place(rig, "/home/steve/projects/rig/.worktrees/retry", project = "project-7" to "rig", workspace = "w1" to "Retry policy")),
        )
        assertEquals(listOf<String?>(null), places.map { it.path })
    }

    @Test fun stillOffersAProjectWorkedOnOnlyInsideItsWorkspacesByIdentity() {
        val places = collectSessionPlaces(
            listOf(rig),
            listOf(
                place(rig, "/home/steve/projects/rig/.worktrees/retry", project = "project-7" to "rig", workspace = "w1" to "Retry policy"),
                place(rig, "/home/steve/projects/rig/.worktrees/other", project = "project-7" to "rig", workspace = "w2" to "Something else"),
            ),
        )
        assertEquals(listOf(SessionPlace(projectPlaceKey("project-7"), "rig", null, "project-7")), places)
        assertEquals("project-7", readProjectPlaceKey(places[0].key))
        assertNull(readProjectPlaceKey("/home/steve"))
    }

    @Test fun offersAProjectOnceAsTheDirectoryWhenItsOwnCheckoutIsKnown() {
        val places = collectSessionPlaces(
            listOf(rig),
            listOf(
                place(rig, "/home/steve/projects/rig/.worktrees/retry", project = "project-7" to "rig", workspace = "w1" to "Retry policy"),
                place(rig, "/home/steve/projects/rig", project = "project-7" to "rig"),
            ),
        )
        assertEquals(listOf(SessionPlace("/home/steve/projects/rig", "rig", "/home/steve/projects/rig", "project-7")), places)
    }

    @Test fun leavesOutAProjectWhoseOnlyWorkspaceSessionIsArchived() {
        val places = collectSessionPlaces(
            listOf(rig),
            listOf(place(rig, "/home/steve/projects/rig/.worktrees/old", archived = true, project = "project-7" to "rig", workspace = "w1" to "Put away")),
        )
        assertEquals(emptyList<SessionPlace>(), places)
    }

    @Test fun ignoresAWorkspaceProjectOnAComputerThatIsNotThisOne() {
        val places = collectSessionPlaces(
            listOf(rig),
            listOf(place("someone-elses-laptop", "/home/steve/projects/rig/.worktrees/retry", project = "project-7" to "rig", workspace = "w1" to "Retry policy")),
        )
        assertEquals(emptyList<SessionPlace>(), places)
    }

    private val workspaceSessions by lazy {
        listOf(
            place(rig, "/home/steve/rig/.worktrees/retry", project = "project-7" to "rig", workspace = "w1" to "Retry policy rewrite"),
            place(rig, "/home/steve/rig/.worktrees/old", archived = true, project = "project-7" to "rig", workspace = "w2" to "Put away"),
            place(rig, "/home/steve/other/.worktrees/x", project = "project-9" to "other", workspace = "w3" to "Elsewhere"),
        )
    }

    @Test fun namesEachWorkspaceByItsTitleNotItsBranch() {
        val found = collectSessionWorkspaces(listOf(rig), "project-7", workspaceSessions)
        assertEquals(listOf("Retry policy rewrite"), found.map { it.name })
        assertEquals("w1", found[0].id)
        assertEquals("/home/steve/rig/.worktrees/retry", found[0].path)
    }

    @Test fun offersNoWorkspacesWhenNoProjectIsChosen() {
        assertEquals(emptyList<SessionWorkspace>(), collectSessionWorkspaces(listOf(rig), null, workspaceSessions))
    }

    private val workspaces = listOf(SessionWorkspace("workspace-1", "/project/workspace-1", "One", "/project/workspace-1", "project-1"))

    @Test fun spawnTargetCreatesAChildThroughTheProjectCatalog() {
        assertEquals(HappyAgentSpawnTarget.NewWorkspace("project-1"), resolveHappyAgentSpawnTarget("project-1", WorktreeSelection.NEW, workspaces))
        assertEquals(HappyAgentSpawnTarget.Project("project-1"), resolveHappyAgentSpawnTarget("project-1", WorktreeSelection.NONE, workspaces))
        assertNull(resolveHappyAgentSpawnTarget(null, WorktreeSelection.NEW, workspaces))
    }

    @Test fun spawnTargetStartsInsideAnExistingWorkspaceByDurableIdentity() {
        assertEquals(HappyAgentSpawnTarget.Workspace("workspace-1"), resolveHappyAgentSpawnTarget("project-1", "/project/workspace-1", workspaces))
    }

    @Test fun spawnTargetRefusesToImportAStaleWorkspacePathAsAnotherProject() {
        val error = assertThrows(UnavailableWorkspaceException::class.java) {
            resolveHappyAgentSpawnTarget("project-1", "/project/missing", workspaces)
        }
        assertEquals(true, error.message!!.contains("workspace is no longer available"))
    }

    @Test fun progressNamesEachStepOfTheFlow() {
        assertNull(resolveStartProgress(null, "Codex", picksWorkspaces = false))
        assertEquals(StartProgress.CreatingWorkspace(false), resolveStartProgress(StartPhase.Worktree, "Codex", picksWorkspaces = false))
        assertEquals(StartProgress.Starting("Codex"), resolveStartProgress(StartPhase.Spawning, "Codex", picksWorkspaces = false))
        assertEquals(StartProgress.Opening(), resolveStartProgress(StartPhase.Opening, "Codex", picksWorkspaces = false))
        // A Happy Agent worktree is a workspace.
        assertEquals(StartProgress.CreatingWorkspace(true), resolveStartProgress(StartPhase.Worktree, "Happy", picksWorkspaces = true))
    }

    @Test fun primaryButtonSendsOnlyWhatCanBeSentAndStaysStopThroughCreation() {
        assertEquals(StartButton.Send, resolveStartButton(canSubmit = true, phase = null, canCancel = true))
        assertEquals(StartButton.Idle, resolveStartButton(canSubmit = false, phase = null, canCancel = true))
        for (phase in StartPhase.entries) {
            assertEquals(StartButton.Stop, resolveStartButton(canSubmit = false, phase = phase, canCancel = true))
        }
        assertEquals(StartButton.Busy, resolveStartButton(canSubmit = false, phase = StartPhase.Worktree, canCancel = false))
    }

    @Test fun draftRoundTripsAndToleratesBadFields() {
        val draft = NewSessionDraft(
            input = "fix it",
            selectedMachineId = "m1",
            selectedPath = "~/code",
            agentType = AgentType.Codex,
            pickedAgentType = AgentType.Codex,
            permissionMode = "yolo",
            modelMode = "gpt-5",
            effortLevel = "high",
            sessionType = SessionType.Worktree,
            worktreeKey = WorktreeSelection.NEW,
            updatedAt = 42,
        )
        assertEquals(draft, NewSessionDraft.parse(draft.toJson().toString()))
        assertEquals(
            NewSessionDraft(input = "x"),
            NewSessionDraft.parse("""{"input":"x","agentType":"nope","sessionType":5,"selectedPath":3,"updatedAt":"soon"}"""),
        )
        assertNull(NewSessionDraft.parse("not json"))
    }

    @Test fun choosingAnotherMachineForgetsItsPlaces() {
        val draft = NewSessionDraft(selectedMachineId = "a", selectedPath = "/x", worktreeKey = "/x/.wt").withMachine("b")
        assertEquals(NewSessionDraft(selectedMachineId = "b"), draft)
        val project = NewSessionDraft(selectedPath = "/x").withProject("p")
        assertEquals(null to "p", project.selectedPath to project.selectedProjectId)
    }

    @Test fun resolvesHomeRelativePathsInTheMachinesOwnSeparator() {
        assertEquals("/Users/dev", resolveAbsolutePath("~", "/Users/dev/"))
        assertEquals("/Users/dev/code", resolveAbsolutePath("~/code", "/Users/dev"))
        assertEquals("C:\\Users\\dev\\code", resolveAbsolutePath("~/code", "C:\\Users\\dev"))
        assertEquals("/abs", resolveAbsolutePath("/abs", "/Users/dev"))
        assertEquals("~/code", resolveAbsolutePath("~/code", null))
    }
}
