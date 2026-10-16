package com.slopus.happy.model

import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.settings.AgentDefaultOverrides
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * HomeDock.tsx's option derivation and homeDockInteraction.ts: computers
 * online first, a persisted machine kept through an empty catalog, places
 * named relative to home, a catalog-only project offered only where Happy
 * Agent runs, the worktree choices for git and for Happy Agent
 * workspaces, the CLI's permission modes filtered by its version, Happy
 * Agent's own catalog grouped by provider, and the draft reconciled with
 * the computer.
 */
class NewSessionOptionsTest {
    private val studio = machine(
        "m1",
        machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true, codex = true) },
        activeAt = 5,
    )
    private val laptop = machine(
        "m2",
        machineMetadata(host = "air.local") { put("displayName", "Air"); cliAvailability(claude = true) },
        active = false,
        activeAt = 3,
    )
    private val rig = machine(
        "r1",
        machineMetadata {
            put("machineKind", "rig")
            put("siblingMachineId", "m1")
            putJsonObject("capabilities") { put("newSession", true); put("worktrees", true) }
            putJsonObject("defaults") { put("providerId", "openai"); put("modelId", "gpt"); put("permissionMode", "auto") }
            putJsonArray("models") {
                addJsonObject {
                    put("code", "gpt"); put("id", "gpt"); put("value", "GPT"); put("providerId", "openai"); put("providerName", "OpenAI")
                    putJsonArray("thinkingLevels") { add("low"); add("high") }
                }
                addJsonObject { put("code", "opus"); put("id", "opus"); put("value", "Opus"); put("providerId", "anthropic"); put("providerName", "Anthropic") }
            }
            putJsonArray("operatingModes") {
                addJsonObject { put("code", "auto"); put("value", "Auto") }
                addJsonObject { put("code", "read_only"); put("value", "Read only") }
            }
        },
    )
    private val overrides = AgentDefaultOverrides()

    private fun resolve(draft: NewSessionDraft, machines: List<Machine> = listOf(laptop, studio), sessions: List<Session> = emptyList(), worktrees: WorktreeListing? = null) =
        resolveNewSessionOptions(draft, machines, sessions, overrides, worktrees, NewSessionLabels(lastSeen = { "seen $it" }))

    @Test fun computersOnlineFirstAndAStaleMachineBecomesTheFirst() {
        val options = resolve(NewSessionDraft(selectedMachineId = "gone"))
        assertEquals(listOf("m1", "m2"), options.machines.map { it.key })
        assertEquals(listOf("online", "seen 3"), options.machines.map { it.description })
        assertEquals("m1", options.resolvedMachineId)
        // An empty catalog (still syncing) keeps the persisted pick.
        assertEquals("gone", resolve(NewSessionDraft(selectedMachineId = "gone"), machines = emptyList()).resolvedMachineId)
    }

    @Test fun placesAreNamedRelativeToHomeAndProjectsByName() {
        val sessions = listOf(
            session("a", metadata(path = "/Users/dev/code") { put("machineId", "m1") }),
            session("b", rigMetadata(path = "/Users/dev/app", machineId = "r1", projectId = "p1", projectName = "App")),
        )
        val options = resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio, rig), sessions)
        val byKey = options.projects.associateBy { it.key }
        assertEquals("~", byKey.getValue("~").name)
        assertEquals("~/code", byKey.getValue("/Users/dev/code").name)
        assertEquals("App", byKey.getValue("/Users/dev/app").name)
        assertEquals("~/app", byKey.getValue("/Users/dev/app").description)
        assertEquals("~", options.project?.key)
    }

    @Test fun aCatalogOnlyProjectNeedsHappyAgent() {
        val inWorkspace = listOf(
            session("w", rigMetadata(path = "/Users/dev/app/.dev/worktree/x", machineId = "r1", projectId = "p1", projectName = "App", workspaceId = "ws1", workspaceName = "x")),
        )
        assertTrue(resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio, rig), inWorkspace).projects.any { it.key == projectPlaceKey("p1") })
        val cliOnly = listOf(inWorkspace.single().let { it.copy(metadata = it.metadata!!.copy(machineId = "m1")) })
        assertTrue(resolve(NewSessionDraft(selectedMachineId = "m1"), listOf(studio), cliOnly).projects.none { it.key == projectPlaceKey("p1") })
    }

    @Test fun gitWorktreesCountOnlyForTheirTarget() {
        val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code", sessionType = SessionType.Worktree, worktreeKey = "/Users/dev/code/.dev/worktree/calm")
        val target = WorktreeTarget("m1", "/Users/dev/code")
        val listed = resolve(draft, worktrees = WorktreeListing(target, listOf(GitWorktree("/Users/dev/code/.dev/worktree/calm", "calm"))))
        assertEquals(target, listed.worktreeTarget)
        assertEquals(listOf(WorktreeSelection.NEW, WorktreeSelection.NONE, "/Users/dev/code/.dev/worktree/calm"), listed.worktrees.map { it.key })
        assertEquals(listOf("Create New Worktree", "No worktree", "calm"), listed.worktrees.map { it.name })
        assertEquals("calm", listed.worktree?.name)
        // Another directory's listing is not this one's: the pick keeps a row of its own.
        val stale = resolve(draft, worktrees = WorktreeListing(WorktreeTarget("m1", "/elsewhere"), listOf(GitWorktree("/x", "x"))))
        assertEquals(listOf(WorktreeSelection.NEW, WorktreeSelection.NONE, "/Users/dev/code/.dev/worktree/calm"), stale.worktrees.map { it.key })
        assertEquals("/Users/dev/code/.dev/worktree/calm", stale.worktree?.name)
    }

    @Test fun aHappyAgentProjectPicksWorkspaces() {
        val sessions = listOf(
            session("b", rigMetadata(path = "/Users/dev/app", machineId = "r1", projectId = "p1", projectName = "App")),
            session("w", rigMetadata(path = "/Users/dev/app/.dev/worktree/x", machineId = "r1", projectId = "p1", projectName = "App", workspaceId = "ws1", workspaceName = "feature")),
        )
        val options = resolve(NewSessionDraft(selectedMachineId = "m1", selectedProjectId = "p1", agentType = AgentType.Rig), listOf(studio, rig), sessions)
        assertTrue(options.picksWorkspaces)
        assertNull("no git listing for a workspace project", options.worktreeTarget)
        assertEquals(listOf("Create New Workspace", "Main", "feature"), options.worktrees.map { it.name })
        assertEquals("Main", options.worktree?.name)
    }

    @Test fun theCliParsesOnlyTheModesItKnows() {
        // happyCliVersion 1.0.0 predates `auto`.
        val options = resolve(NewSessionDraft(selectedMachineId = "m1", agentType = AgentType.Claude, permissionMode = "auto"))
        assertTrue(options.permissions.none { it.key == "auto" })
        assertEquals("the code default, not the first row", "default", options.permission?.key)
        assertEquals(listOf("claude", "codex"), options.agents.map { it.key })
        assertEquals("Claude Code", options.agent.name)
    }

    @Test fun happyAgentOffersItsOwnCatalog() {
        val options = resolve(NewSessionDraft(selectedMachineId = "m1", agentType = AgentType.Rig), listOf(studio, rig))
        assertEquals(listOf("OpenAI", "Anthropic"), options.models.map { it.title })
        assertEquals("GPT", options.model?.name)
        assertEquals("Auto", options.permissionLabel)
        assertEquals(listOf("low", "high"), options.efforts.map { it.key })
        assertEquals("low", options.effort?.key)
        assertEquals(listOf("Read"), listOf(permissionModeShortLabel("Read only")))
    }

    @Test fun theDraftFollowsTheComputer() {
        val machines = listOf(laptop, studio)
        // A machine that left, a harness the computer doesn't run, and a worktree where none can be made.
        val draft = NewSessionDraft(selectedMachineId = "gone", agentType = AgentType.OpenClaw, sessionType = SessionType.Worktree)
        fun step(from: NewSessionDraft) = resolve(from, machines).reconcile(from, machines, overrides)
        val first = step(draft)
        assertEquals("m1", first.selectedMachineId)
        assertEquals("no worktree for OpenClaw", SessionType.Simple, first.sessionType)
        // Each pass reads the computer the last one settled on.
        val settled = step(first)
        assertEquals(AgentType.Claude, settled.agentType)
        assertNull("following the computer is not a pick", settled.pickedAgentType)
        assertEquals(settled, step(settled))
    }

    @Test fun picksChangeTheDraft() {
        val machines = listOf(studio, rig)
        val draft = NewSessionDraft(selectedMachineId = "m1", selectedPath = "~/code", worktreeKey = "x")
        val project = draft.selectingProject(projectPlaceKey("p1"), machines, overrides)
        assertEquals("p1", project.selectedProjectId)
        assertNull(project.selectedPath)
        assertEquals(AgentType.Rig, project.pickedAgentType)
        assertEquals("Happy Agent's defaults", "auto", project.permissionMode)
        assertEquals("/srv", draft.selectingProject("/srv", machines, overrides).selectedPath)
        assertEquals(SessionType.Worktree to null, draft.selectingWorktree(WorktreeSelection.NEW).let { it.sessionType to it.worktreeKey })
        assertEquals(SessionType.Simple to null, draft.selectingWorktree(WorktreeSelection.NONE).let { it.sessionType to it.worktreeKey })
        assertEquals(SessionType.Worktree to "/wt", draft.selectingWorktree("/wt").let { it.sessionType to it.worktreeKey })
    }

    @Test fun modesTaggedWithACliVersion() {
        val auto = com.slopus.happy.model.settings.ModeOption("auto", "Auto", sinceCliVersion = "1.2.1-beta.2")
        assertTrue(modeSupportedByCli(auto, null))
        assertTrue(modeSupportedByCli(auto, "1.2.1"))
        assertEquals(false, modeSupportedByCli(auto, "1.0.0"))
        assertEquals(false, modeSupportedByCli(auto, "garbage"))
    }
}
