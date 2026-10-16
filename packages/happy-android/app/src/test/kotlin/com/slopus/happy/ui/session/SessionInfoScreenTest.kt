package com.slopus.happy.ui.session

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Session
import com.slopus.happy.sync.ForkOptions
import com.slopus.happy.sync.ForkSource
import com.slopus.happy.sync.OpResult
import com.slopus.happy.sync.RewindPoint
import com.slopus.happy.sync.RewindPointsResult
import com.slopus.happy.sync.SpawnSessionResult
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.home.ArchiveResult
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.ZoneOffset

/**
 * session/[id]/info.tsx: a centred title; loading and deleted states; quick
 * actions in happy-app's order (changes, machine, resume, fork, duplicate,
 * parent, archive, delete — fork and duplicate only with the experiment and
 * an online machine, delete never for a bot); archive leaves on success and
 * says why on failure; delete asks first; the ids copy; duplicate opens the
 * rewind points newest first and forks up to the one picked.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionInfoScreenTest {
    @get:Rule val rule = createComposeRule()

    private class Fakes : SessionInfoControls, SessionContinuations {
        val calls = mutableListOf<String>()
        var archive: ArchiveResult = ArchiveResult.Archived
        val points = listOf(
            RewindPoint("u1", "first   question", 1_000.0),
            RewindPoint("u2", "second question", 2_000.0),
        )

        override suspend fun archive(session: Session): ArchiveResult = archive.also { calls += "archive:${session.id}" }
        override suspend fun delete(session: Session): OpResult = OpResult(true).also { calls += "delete:${session.id}" }
        override suspend fun resume(machineId: String, sessionId: String) = SpawnSessionResult.Success("resumed").also { calls += "resume" }
        override suspend fun fork(source: ForkSource, options: ForkOptions): SpawnSessionResult {
            calls += "fork:${options.cutAfterUuid}"
            return SpawnSessionResult.Success("forked")
        }
        override suspend fun rewindPoints(source: ForkSource) = RewindPointsResult.Success(points)
    }

    private val online = machine("m1", machineMetadata { cliAvailability(claude = true) }, active = true)

    private fun claudeSession(active: Boolean = true, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}) = session(
        "session-0123456789-abcdef",
        metadata = metadata(path = "/Users/dev/app") {
            put("machineId", "m1")
            put("claudeSessionId", "claude-0123456789-xyz")
            putJsonObject("summary") { put("text", "Fix the build"); put("updatedAt", 0) }
            extra()
        },
        active = active,
    )

    private val opened = mutableListOf<String>()
    private val copied = mutableListOf<String>()
    private var left = 0
    private val actions = SessionInfoActions(
        onBack = {},
        onOpenSession = { opened += it },
        onOpenMachine = { opened += "machine:$it" },
        onChanges = null,
        onArchived = { left++ },
        onDeleted = { left++ },
        copyToClipboard = { copied += it },
    )

    private fun show(session: Session?, ready: Boolean = true, experiments: Boolean = true, fakes: Fakes = Fakes(), devMode: Boolean = false) {
        rule.setHappyContent {
            SessionInfoScreen(session, ready, null, online, experiments, devMode, fakes, fakes, actions, zone = ZoneOffset.UTC)
        }
    }

    private fun tagged(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true)

    @Test
    fun loadingUntilTheFirstSync() {
        show(null, ready = false)
        rule.node(SessionInfoTags.LOADING).assertExists()
    }

    @Test
    fun aSessionThatIsGoneSaysSo() {
        show(null, ready = true)
        rule.node(SessionInfoTags.DELETED).assertExists()
    }

    @Test
    fun centredTitleAndQuickActionsInOrder() {
        show(claudeSession())
        val bar = rule.node(HeaderTags.BAR).bounds
        assertDp("header", 64, bar.bottom - bar.top)
        val title = rule.node(HeaderTags.TITLE).bounds
        assertDp("title centred", (PHONE_WIDTH / 2f).dp, (title.left + title.right) / 2)
        rule.onNodeWithText("Fix the build").assertExists()
        val order = listOf(
            SessionInfoTags.CHANGES, SessionInfoTags.MACHINE, SessionInfoTags.FORK, SessionInfoTags.DUPLICATE,
            SessionInfoTags.ARCHIVE, SessionInfoTags.DELETE,
        ).map { rule.node(it).bounds }
        order.zipWithNext().forEach { (a, b) -> assertDp("rows stack", a.bottom, b.top) }
        // Online: nothing to resume.
        tagged(SessionInfoTags.RESUME).assertCountEquals(0)
    }

    @Test
    fun forkAndDuplicateNeedTheExperiment() {
        show(claudeSession(), experiments = false)
        tagged(SessionInfoTags.FORK).assertCountEquals(0)
        tagged(SessionInfoTags.DUPLICATE).assertCountEquals(0)
    }

    @Test
    fun offlineSessionResumesAndShowsItsResumeCommand() {
        val fakes = Fakes()
        val offline = claudeSession(active = false)
        rule.setHappyContent {
            val machine = online.copy(metadata = machineMetadata { putJsonObject("resumeSupport") { put("rpcAvailable", true) } })
            SessionInfoScreen(offline, true, null, machine, true, false, fakes, fakes, actions, zone = ZoneOffset.UTC)
        }
        rule.node(SessionInfoTags.RESUME).performClick()
        rule.waitForIdle()
        assertEquals(listOf("resumed"), opened)
        rule.node(SessionInfoTags.RESUME_COMMAND).performScrollTo().performClick()
        assertEquals(listOf("cd '/Users/dev/app' && happy claude --resume claude-0123456789-xyz"), copied)
    }

    @Test
    fun archiveLeavesOnSuccess() {
        val fakes = Fakes()
        show(claudeSession(), fakes = fakes)
        rule.node(SessionInfoTags.ARCHIVE).performClick()
        rule.waitForIdle()
        assertEquals(1, left)
    }

    @Test
    fun aFailedArchiveSaysWhyAndStays() {
        val failing = Fakes().apply { archive = ArchiveResult.Failed("agent gone", bot = false) }
        show(claudeSession(), fakes = failing)
        rule.node(SessionInfoTags.ARCHIVE).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("agent gone").assertExists()
        assertEquals(0, left)
    }

    @Test
    fun deleteAsksFirst() {
        val fakes = Fakes()
        show(claudeSession(), fakes = fakes)
        rule.node(SessionInfoTags.DELETE).performClick()
        rule.onNode(hasText("Delete Session") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        rule.waitForIdle()
        assertEquals(listOf("delete:session-0123456789-abcdef"), fakes.calls)
        assertEquals(1, left)
    }

    @Test
    fun aBotIsNeverOfferedDelete() {
        val bot = claudeSession {
            putJsonObject("bot") {
                put("id", "b"); put("name", "Helper"); put("username", "helper"); put("workspaceId", "w"); put("orderKey", "a")
                put("systemKey", kotlinx.serialization.json.JsonNull)
            }
        }
        show(bot)
        tagged(SessionInfoTags.DELETE).assertCountEquals(0)
    }

    @Test
    fun idsCopyAndShowShortened() {
        show(claudeSession())
        rule.onNodeWithText("session-...9-abcdef").assertExists()
        rule.node(SessionInfoTags.SESSION_ID).performScrollTo().performClick()
        assertEquals(listOf("session-0123456789-abcdef"), copied)
    }

    @Test
    fun duplicatePicksARewindPointNewestFirst() {
        val fakes = Fakes()
        show(claudeSession(), fakes = fakes)
        rule.node(SessionInfoTags.DUPLICATE).performClick()
        rule.waitForIdle()
        rule.node(DuplicateSheetTags.SHEET).assertExists()
        val rows = rule.onAllNodesWithTag(DuplicateSheetTags.ROW, useUnmergedTree = true)
        rows.assertCountEquals(2)
        rule.onNodeWithText("first question").assertExists()
        rows[0].performClick()
        rule.node(DuplicateSheetTags.CONFIRM).performClick()
        rule.waitForIdle()
        assertEquals(listOf("fork:u2"), fakes.calls)
        assertEquals(listOf("forked"), opened)
        rule.onAllNodesWithTag(DuplicateSheetTags.SHEET, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun duplicateSheetIsInsetAndCapped() {
        show(claudeSession())
        rule.node(SessionInfoTags.DUPLICATE).performClick()
        rule.waitForIdle()
        val sheet = rule.node(DuplicateSheetTags.SHEET).bounds
        assertDp("16 in from each side", PHONE_WIDTH - 32, sheet.right - sheet.left)
        assertTrue("no taller than 85% of the window", (sheet.bottom - sheet.top) <= (891 * 0.85f).dp)
    }

    @Test
    fun devModeShowsTheRawJson() {
        show(claudeSession(), devMode = true)
        rule.node(SessionInfoTags.RAW_JSON).performScrollTo().assertExists()
    }

    @Test
    fun rewindPreviewCollapsesAndCuts() {
        assertEquals("a b", rewindPreview("  a \n b "))
        assertEquals("x".repeat(140) + "…", rewindPreview("x".repeat(200)))
    }
}
