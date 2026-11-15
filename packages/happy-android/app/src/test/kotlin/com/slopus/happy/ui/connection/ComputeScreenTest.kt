package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.ComputeAccess
import com.slopus.happy.agent.ComputeAgent
import com.slopus.happy.agent.ComputeBoundary
import com.slopus.happy.agent.ComputeApproval
import com.slopus.happy.agent.ComputeCommands
import com.slopus.happy.agent.ComputeDraft
import com.slopus.happy.agent.ComputeInstall
import com.slopus.happy.agent.Computer
import com.slopus.happy.agent.ComputeOwner
import com.slopus.happy.agent.ComputeRole
import com.slopus.happy.agent.ComputeSnapshot
import com.slopus.happy.agent.ComputeSource
import com.slopus.happy.agent.ComputeStatus
import com.slopus.happy.agent.ComputeSystem
import com.slopus.happy.agent.ComputerAdd
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ComputeScreenTest {
    @get:Rule val rule = createComposeRule()

    private val open = ComputeBoundary(true, null)
    private val shared = Computer("n1", "build-01", ComputeStatus.Online, "build-01", "linux", "x86_64", ComputeAccess.Shared, null, 8, 16,
        listOf(ComputeAgent("a7", "Ship the release"), ComputeAgent("a9", null)), open, "GPU box, CUDA 12.4", null)
    private val full = Computer("n3", "Mac mini", ComputeStatus.Online, "mini.local", "macos", "aarch64", ComputeAccess.Shared, null, 1, null,
        listOf(ComputeAgent("a3", "Profile cold start")), ComputeBoundary(false, "bwrap: no user namespaces."), null, null)
    private val mine = Computer("n4", "Laptop", ComputeStatus.Online, "laptop", "windows", "x86_64", ComputeAccess.Private, ComputeOwner.Reader, 2, 4,
        listOf(ComputeAgent("a5", "Fix the build")), open, "My own", null)
    private val theirs = Computer("n5", "Desk", ComputeStatus.Offline, "desk", "linux", "x86_64", ComputeAccess.Private, ComputeOwner.Member("u-ana", "Ana"), 2, null, emptyList(), open, null, null)
    private val request = ComputeApproval("n4", "Laptop", "a1", "Fix the build", System.currentTimeMillis())

    private fun loaded(vararg computers: Computer, approvals: List<ComputeApproval> = emptyList()) =
        ComputeSource.State.Loaded(ComputeSnapshot(computers.toList(), approvals))

    @Test
    fun theListShowsAccessOwnerPlacesAndTheBoundaryAndOpensAComputer() {
        val opened = mutableListOf<String>()
        rule.setHappyContent {
            ComputeScreen(loaded(shared, full, mine, theirs), ComputeRole.Manage, ComputePending(), null, ComputeActions(onOpen = { opened += it.id }), {})
        }
        rule.onAllNodesWithText("Shared").assertCountEquals(2)
        rule.onAllNodesWithText("Private").assertCountEquals(2)
        rule.onNodeWithText("COMPUTERS").assertExists()
        rule.onNodeWithText("Yours").assertExists()
        rule.onNodeWithText("Ana's").assertExists()
        rule.onNodeWithText("2 of 8 agents").assertExists()
        rule.onNodeWithText("1 of 1 agent").assertExists()
        rule.onNodeWithText("1 of 2 agents").assertExists()
        rule.onNodeWithText("0 of 2 agents").assertExists()
        rule.onNodeWithText("Full").assertExists()
        rule.onAllNodesWithText("Online").assertCountEquals(2)
        rule.onNodeWithText("Offline").assertExists()
        rule.onAllNodesWithText("Restricted commands can't run here").assertCountEquals(1)
        rule.onNodeWithText("GPU box, CUDA 12.4").assertExists()
        rule.onNodeWithText("mini.local · macOS aarch64").assertExists()
        val row = rule.node(ComputeTags.computer("n1"))
        // 16dp margins and the settings card's one-physical-pixel border on each side.
        assertDp("computer row width", (379 - 2f / rule.density.density).dp, row.bounds.width)
        rule.onNodeWithTag(ComputeTags.computer("n3")).performScrollTo().performClick()
        assertEquals(listOf("n3"), opened)
    }

    @Test
    fun aMemberSeesTheirFooterAndAdds() {
        rule.setHappyContent { ComputeScreen(loaded(shared, mine), ComputeRole.Use, ComputePending(), null, ComputeActions(), {}) }
        rule.onNodeWithText("Agents choose a computer and join it. You can add a private computer of your own.").assertExists()
        rule.onNodeWithTag(ComputeTags.ADD).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun joinRequestsAnswerOnceAndShowWhichComputer() {
        val answers = mutableListOf<Pair<String, Boolean>>()
        rule.setHappyContent {
            ComputeScreen(loaded(mine, approvals = listOf(request)), ComputeRole.Use, ComputePending(), null, ComputeActions(onAnswer = { a, ok -> answers += a.key to ok }), {})
        }
        rule.onNodeWithText("JOIN REQUESTS").assertExists()
        rule.onNodeWithText("Wants to join Laptop · just now").assertExists()
        rule.onNodeWithTag(ComputeTags.approve("n4/a1")).performClick()
        rule.onNodeWithTag(ComputeTags.deny("n4/a1")).performClick()
        assertEquals(listOf("n4/a1" to true, "n4/a1" to false), answers)
    }

    @Test
    fun anAnswerUnderWayHoldsBothButtons() {
        rule.setHappyContent {
            ComputeScreen(loaded(approvals = listOf(request.copy(computerName = null, agentTitle = null))), ComputeRole.Use, ComputePending(answers = mapOf("n4/a1" to true)), null, ComputeActions(), {})
        }
        rule.onNodeWithText("An agent").assertExists()
        rule.onNodeWithText("Wants to join your computer · just now").assertExists()
        rule.onNodeWithTag(ComputeTags.approve("n4/a1")).assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.deny("n4/a1")).assertIsNotEnabled()
        rule.onNodeWithText("No computer has joined yet.").assertExists()
    }

    @Test
    fun noComputersSaysWhatTheReaderCanDo() {
        rule.setHappyContent { ComputeScreen(loaded(), ComputeRole.Use, ComputePending(), null, ComputeActions(), {}) }
        rule.onNodeWithText("No compute yet").assertExists()
        rule.onNodeWithText("No computer has joined this server yet. You can add a private one of your own.").assertExists()
        rule.onNodeWithTag(ComputeTags.ADD).assertExists()
    }

    @Test
    fun withoutComputeUseNothingIsShown() {
        rule.setHappyContent { ComputeScreen(loaded(shared), ComputeRole.None, ComputePending(), null, ComputeActions(), {}) }
        rule.onNodeWithText("Using compute needs the compute.use permission.").assertIsDisplayed()
        rule.onAllNodesWithText("build-01").assertCountEquals(0)
        rule.onAllNodesWithTag(ComputeTags.ADD).assertCountEquals(0)
    }

    @Test
    fun aLoadFailureHasAnExplicitRetry() {
        var retries = 0
        rule.setHappyContent { ComputeScreen(ComputeSource.State.Failed, ComputeRole.Use, ComputePending(), null, ComputeActions(onRetry = { retries++ }), {}) }
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun aManagerRemovesAnAgentAndChangesConcurrency() {
        val removed = mutableListOf<String>()
        val saved = mutableListOf<Int>()
        rule.setHappyContent {
            ComputerScreen(loaded(shared), "n1", ComputeRole.Manage, ComputerPending(), null, ComputerActions(onRemove = { removed += it.id }, onSave = { saved += it }), {})
        }
        rule.onNodeWithText("2 OF 8 AGENTS").assertExists()
        rule.onNodeWithText("Ship the release").assertExists()
        rule.onNodeWithTag(ComputeTags.agent("a9")).assertExists()
        rule.onAllNodesWithTag(ComputeTags.BOUNDARY).assertCountEquals(0)
        assertTrue(rule.node(ComputeTags.remove("a7")).bounds.height.value >= 48)
        rule.onNodeWithTag(ComputeTags.remove("a7")).performClick()
        assertEquals(listOf("a7"), removed)
        rule.onNodeWithText("How many agents can work on this computer at the same time, from 1 to 16.").performScrollTo().assertExists()
        rule.onAllNodesWithTag(ComputeTags.SAVE).assertCountEquals(0)
        rule.onNodeWithTag(ComputeTags.MORE).performScrollTo().performClick()
        rule.onNodeWithTag(ComputeTags.MORE).performClick()
        rule.onNodeWithTag(ComputeTags.FEWER).performClick()
        rule.onNodeWithTag(ComputeTags.SAVE).performScrollTo().performClick()
        assertEquals(listOf(9), saved)
    }

    @Test
    fun concurrencyStopsAtTheComputersLimit() {
        rule.setHappyContent { ComputerScreen(loaded(mine.copy(concurrency = 4)), "n4", ComputeRole.Use, ComputerPending(), null, ComputerActions(), {}) }
        rule.onNodeWithTag(ComputeTags.MORE).performScrollTo().assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.FEWER).assertIsEnabled()
    }

    @Test
    fun thePrivateOwnerManagesTheirComputer() {
        rule.setHappyContent { ComputerScreen(loaded(mine.copy(concurrency = 1)), "n4", ComputeRole.Use, ComputerPending(), null, ComputerActions(), {}) }
        rule.onNodeWithTag(ComputeTags.remove("a5")).assertExists()
        rule.onNodeWithTag(ComputeTags.FEWER).performScrollTo().assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.MORE).assertIsEnabled()
    }

    @Test
    fun aMemberOnlyReadsASharedComputer() {
        rule.setHappyContent { ComputerScreen(loaded(full), "n3", ComputeRole.Use, ComputerPending(), null, ComputerActions(), {}) }
        rule.onNodeWithText("1 OF 1 AGENT").assertExists()
        rule.onNodeWithText("Profile cold start").assertExists()
        rule.onAllNodesWithTag(ComputeTags.remove("a3")).assertCountEquals(0)
        rule.onAllNodesWithTag(ComputeTags.MORE).assertCountEquals(0)
        rule.onNodeWithTag(ComputeTags.CONCURRENCY).performScrollTo().assertExists()
    }

    @Test
    fun anUnavailableBoundarySaysWhyAndWhatStillRuns() {
        rule.setHappyContent { ComputerScreen(loaded(full), "n3", ComputeRole.Manage, ComputerPending(), null, ComputerActions(), {}) }
        rule.onNodeWithTag(ComputeTags.BOUNDARY).assertExists()
        rule.onNodeWithText("Restricted commands can't run here").assertExists()
        rule.onNodeWithText("bwrap: no user namespaces. Only full-access commands run on this computer.").assertExists()
        rule.onNodeWithText("Full").assertExists()
    }

    @Test
    fun aRemovalUnderWayAndARefusalShowOnTheComputer() {
        rule.setHappyContent {
            ComputerScreen(loaded(shared), "n1", ComputeRole.Manage, ComputerPending(removals = setOf("a7")), ComputeFailure("No such agent."), ComputerActions(), {})
        }
        rule.onNodeWithTag(ComputeTags.remove("a7")).assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.remove("a9")).assertIsEnabled()
        rule.onNodeWithText("That didn't go through").assertExists()
        rule.onNodeWithText("No such agent.").assertExists()
    }

    @Test
    fun aComputerNoLongerListedSaysSo() {
        rule.setHappyContent { ComputerScreen(loaded(shared), "gone", ComputeRole.Manage, ComputerPending(), null, ComputerActions(), {}) }
        rule.onNodeWithText("This computer is no longer listed.").assertExists()
    }

    @Test
    fun aMemberMayPickOnlyPrivate() {
        var changes = 0
        rule.setHappyContent { ComputerAddScreen(ComputerAdd.open(ComputeRole.Use)!!, ComputeRole.Use, { changes++ }, {}, {}) }
        rule.onNodeWithTag(ComputeTags.access(ComputeAccess.Shared)).assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.access(ComputeAccess.Private)).assertIsEnabled()
        rule.onNodeWithText("Add a computer").assertExists()
        rule.onNodeWithText("Just for you. Only your agents can join, and you approve each one.").assertExists()
        rule.onNodeWithText("Shared computers need admin permission. You can add a private computer of your own.").assertExists()
        rule.onNodeWithTag(ComputeTags.access(ComputeAccess.Shared)).performClick()
        assertEquals(0, changes)
        rule.onNodeWithTag(ComputeTags.CONCURRENCY).assertExists()
        rule.onNodeWithTag(ComputeTags.FEWER).assertIsNotEnabled()
    }

    @Test
    fun aManagerPicksAccessAndConcurrencyAndCreates() {
        var add: ComputerAdd = ComputerAdd.open(ComputeRole.Manage)!!
        var creates = 0
        rule.setHappyContent {
            var shown by remember { mutableStateOf(add) }
            ComputerAddScreen(shown, ComputeRole.Manage, { change -> shown = shown.edit(ComputeRole.Manage, change); add = shown }, { creates++ }, {})
        }
        rule.onNodeWithText("8").assertExists()
        rule.onNodeWithTag(ComputeTags.access(ComputeAccess.Private)).performClick()
        rule.onNodeWithText("1").assertExists()
        rule.onNodeWithTag(ComputeTags.MORE).performScrollTo().performClick()
        assertEquals(ComputeDraft(ComputeAccess.Private, 2), add.form)
        rule.onNodeWithTag(ComputeTags.CREATE).performScrollTo().performClick()
        assertEquals(1, creates)
    }

    @Test
    fun aRefusedCreateKeepsTheFormWithTheReason() {
        rule.setHappyContent {
            ComputerAddScreen(ComputerAdd.Failed(ComputeDraft(ComputeAccess.Private), "Compute nodes are not configured on this deployment."), ComputeRole.Use, {}, {}, {})
        }
        rule.onNodeWithText("No install command").assertExists()
        rule.onNodeWithText("Compute nodes are not configured on this deployment.").assertExists()
        rule.onNodeWithTag(ComputeTags.access(ComputeAccess.Private)).assertExists()
    }

    private val linux = setOf(ComputeSystem.Linux)

    private fun install(
        access: ComputeAccess,
        systems: Set<ComputeSystem> = linux,
        commands: ComputeCommands? = ComputeCommands("curl -fsSL https://get.example/install.sh | HAPPY_JOIN_TOKEN='jt-secret' sh", "irm https://get.example/install.ps1 | iex"),
        notice: String? = "macOS and Windows computers are not available yet.",
        expiresAt: Long = System.currentTimeMillis() + 3_600_000,
    ) = ComputerAdd.Shown(ComputeInstall(access, access.defaultConcurrency, commands, systems, notice, "jt-secret", "https://acme.happy-clusters.com", expiresAt))

    @Test
    fun aLinuxInstallShowsItsCommandVerbatimWithTheNoticeAndCopiesSensitively() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeAccess.Private), ComputeRole.Use, {}, {}, {}) }
        rule.onNodeWithText("Run this on your own computer", substring = true).assertExists()
        rule.onNodeWithText("macOS and Windows computers are not available yet.", substring = true).assertExists()
        rule.onNodeWithText("LINUX").assertExists()
        rule.onAllNodesWithTag(ComputeTags.command("windows")).assertCountEquals(0)
        rule.onNodeWithTag(ComputeTags.command("unix")).assertTextEquals("curl -fsSL https://get.example/install.sh | HAPPY_JOIN_TOKEN='jt-secret' sh")
        rule.onAllNodesWithText("Copy")[0].performClick()
        rule.waitForIdle()
        val clipboard = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(android.content.ClipboardManager::class.java)
        assertEquals("curl -fsSL https://get.example/install.sh | HAPPY_JOIN_TOKEN='jt-secret' sh", clipboard.primaryClip!!.getItemAt(0).text.toString())
        assertTrue(clipboard.primaryClip!!.description.extras.getBoolean("android.content.extra.IS_SENSITIVE"))
        rule.onNodeWithText("Copied").assertExists()
    }

    @Test
    fun everyPublishedSystemGetsItsCommand() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeAccess.Shared, setOf(ComputeSystem.Linux, ComputeSystem.MacOS, ComputeSystem.Windows), notice = null), ComputeRole.Manage, {}, {}, {}) }
        rule.onNodeWithText("Run this on the computer your team's agents will use", substring = true).assertExists()
        rule.onNodeWithText("MACOS AND LINUX").assertExists()
        rule.onNodeWithText("WINDOWS (POWERSHELL)").performScrollTo().assertExists()
        rule.onNodeWithTag(ComputeTags.command("windows")).assertTextEquals("irm https://get.example/install.ps1 | iex")
    }

    @Test
    fun withoutAnInstallerTheServerAndTokenAreShown() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeAccess.Shared, commands = null), ComputeRole.Manage, {}, {}, {}) }
        rule.onNodeWithTag(ComputeTags.command("server")).assertTextEquals("https://acme.happy-clusters.com")
        rule.onNodeWithTag(ComputeTags.command("token")).assertTextEquals("jt-secret")
        rule.onAllNodesWithTag(ComputeTags.command("unix")).assertCountEquals(0)
    }

    @Test
    fun withNoPublishedPlatformTheServerAndTokenAreShownInsteadOfCommands() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeAccess.Shared, systems = emptySet()), ComputeRole.Manage, {}, {}, {}) }
        rule.onNodeWithTag(ComputeTags.command("server")).assertTextEquals("https://acme.happy-clusters.com")
        rule.onNodeWithTag(ComputeTags.command("token")).assertTextEquals("jt-secret")
        rule.onAllNodesWithTag(ComputeTags.command("unix")).assertCountEquals(0)
        rule.onAllNodesWithTag(ComputeTags.command("windows")).assertCountEquals(0)
    }

    @Test
    fun anExpiredInstallCannotBeReadOrCopied() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeAccess.Private, expiresAt = 1), ComputeRole.Use, {}, {}, {}) }
        rule.onAllNodesWithTag(ComputeTags.command("unix")).assertCountEquals(0)
        rule.onAllNodesWithText("Copy").assertCountEquals(0)
    }
}
