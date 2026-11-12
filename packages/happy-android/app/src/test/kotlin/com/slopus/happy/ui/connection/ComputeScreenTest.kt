package com.slopus.happy.ui.connection

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
import com.slopus.happy.agent.ComputeApproval
import com.slopus.happy.agent.ComputeCommands
import com.slopus.happy.agent.ComputeDraft
import com.slopus.happy.agent.ComputeHolder
import com.slopus.happy.agent.ComputeInstall
import com.slopus.happy.agent.Computer
import com.slopus.happy.agent.ComputeMode
import com.slopus.happy.agent.ComputeModeKind
import com.slopus.happy.agent.ComputeOwner
import com.slopus.happy.agent.ComputeSnapshot
import com.slopus.happy.agent.ComputeSource
import com.slopus.happy.agent.ComputeStatus
import com.slopus.happy.agent.ComputerAdd
import com.slopus.happy.agent.ComputerEdit
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

    private val sandbox = Computer("n1", "build-01", ComputeStatus.Online, "build-01", "linux", "x86_64", ComputeMode.Sandbox, "GPU box, CUDA 12.4", null, null)
    private val shared = Computer("n2", "Team box", ComputeStatus.Online, "team", "linux", "aarch64", ComputeMode.Shared, null, null, null)
    private val exclusive = Computer("n3", "Mac mini", ComputeStatus.Online, "mini.local", "macos", "aarch64", ComputeMode.Exclusive(ComputeHolder("a7", "Ship the release")), null, null, null)
    private val mine = Computer("n4", "Laptop", ComputeStatus.Online, "laptop", "windows", "x86_64", ComputeMode.Private(ComputeOwner.Reader), "My own", null, null)
    private val theirs = Computer("n5", "Desk", ComputeStatus.Offline, "desk", "linux", "x86_64", ComputeMode.Private(ComputeOwner.Member("u-ana", "Ana")), null, null, null)
    private val request = ComputeApproval("n4", "Laptop", "a1", "Fix the build", System.currentTimeMillis())

    private fun loaded(vararg computers: Computer, approvals: List<ComputeApproval> = emptyList()) =
        ComputeSource.State.Loaded(ComputeSnapshot(computers.toList(), approvals))

    @Test
    fun aManagerSeesEveryModeWithItsHolderOwnerAndActions() {
        val edits = mutableListOf<String>()
        val releases = mutableListOf<String>()
        rule.setHappyContent {
            ComputeScreen(
                loaded(sandbox, shared, exclusive, mine, theirs), ComputeAccess.Manage, ComputePending(), null,
                ComputeActions(onEdit = { edits += it.id }, onRelease = { releases += it.id }), {},
            )
        }
        for (label in listOf("Sandbox", "Shared", "Exclusive")) rule.onNodeWithText(label).assertExists()
        rule.onAllNodesWithText("Private").assertCountEquals(2)
        rule.onNodeWithText("COMPUTERS").assertExists()
        rule.onNodeWithText("Yours").assertExists()
        rule.onNodeWithText("Ana's").assertExists()
        rule.onNodeWithText("In use").assertExists()
        rule.onNodeWithText("Held by Ship the release").assertExists()
        rule.onNodeWithText("GPU box, CUDA 12.4").assertExists()
        rule.onNodeWithText("mini.local · macOS aarch64").assertExists()
        rule.onAllNodesWithText("Online").assertCountEquals(3)
        rule.onNodeWithText("Offline").assertExists()
        val row = rule.node(ComputeTags.computer("n1"))
        // 16dp margins and the settings card's one-physical-pixel border on each side.
        assertDp("computer row width", (379 - 2f / rule.density.density).dp, row.bounds.width)
        for (id in listOf("n1", "n2", "n3", "n4", "n5")) rule.onNodeWithTag(ComputeTags.edit(id)).assertExists()
        rule.onAllNodesWithTag(ComputeTags.release("n1")).assertCountEquals(0)
        assertTrue(rule.node(ComputeTags.release("n3")).bounds.height.value >= 48)
        rule.onNodeWithTag(ComputeTags.release("n3")).performScrollTo().performClick()
        rule.onNodeWithTag(ComputeTags.edit("n5")).performScrollTo().performClick()
        assertEquals(listOf("n3"), releases)
        assertEquals(listOf("n5"), edits)
    }

    @Test
    fun aMemberEditsOnlyTheirOwnComputerAndReleasesNothing() {
        rule.setHappyContent { ComputeScreen(loaded(sandbox, exclusive, mine), ComputeAccess.Use, ComputePending(), null, ComputeActions(), {}) }
        rule.onNodeWithTag(ComputeTags.edit("n4")).assertExists()
        for (id in listOf("n1", "n3")) rule.onAllNodesWithTag(ComputeTags.edit(id)).assertCountEquals(0)
        rule.onAllNodesWithTag(ComputeTags.release("n3")).assertCountEquals(0)
        rule.onNodeWithText("Agents choose a computer and join it. You can add a private computer of your own.").assertExists()
        rule.onNodeWithTag(ComputeTags.ADD).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun joinRequestsAnswerOnceAndShowWhichComputer() {
        val answers = mutableListOf<Pair<String, Boolean>>()
        rule.setHappyContent {
            ComputeScreen(loaded(mine, approvals = listOf(request)), ComputeAccess.Use, ComputePending(), null, ComputeActions(onAnswer = { a, ok -> answers += a.key to ok }), {})
        }
        rule.onNodeWithText("JOIN REQUESTS").assertExists()
        rule.onNodeWithText("Fix the build").assertExists()
        rule.onNodeWithText("Wants to join Laptop · just now").assertExists()
        rule.onNodeWithTag(ComputeTags.approve("n4/a1")).performClick()
        rule.onNodeWithTag(ComputeTags.deny("n4/a1")).performClick()
        assertEquals(listOf("n4/a1" to true, "n4/a1" to false), answers)
    }

    @Test
    fun anAnswerUnderWayHoldsBothButtons() {
        rule.setHappyContent {
            ComputeScreen(loaded(approvals = listOf(request.copy(computerName = null, agentTitle = null))), ComputeAccess.Use, ComputePending(answers = mapOf("n4/a1" to true)), null, ComputeActions(), {})
        }
        rule.onNodeWithText("An agent").assertExists()
        rule.onNodeWithText("Wants to join your computer · just now").assertExists()
        rule.onNodeWithTag(ComputeTags.approve("n4/a1")).assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.deny("n4/a1")).assertIsNotEnabled()
        rule.onNodeWithText("No computer has joined yet.").assertExists()
    }

    @Test
    fun noComputersSaysWhatTheReaderCanDo() {
        rule.setHappyContent { ComputeScreen(loaded(), ComputeAccess.Use, ComputePending(), null, ComputeActions(), {}) }
        rule.onNodeWithText("No compute yet").assertExists()
        rule.onNodeWithText("No computer has joined this server yet. You can add a private one of your own.").assertExists()
        rule.onNodeWithTag(ComputeTags.ADD).assertExists()
    }

    @Test
    fun withoutComputeUseNothingIsShown() {
        rule.setHappyContent { ComputeScreen(loaded(sandbox), ComputeAccess.None, ComputePending(), null, ComputeActions(), {}) }
        rule.onNodeWithText("Using compute needs the compute.use permission.").assertIsDisplayed()
        rule.onAllNodesWithText("build-01").assertCountEquals(0)
        rule.onAllNodesWithTag(ComputeTags.ADD).assertCountEquals(0)
    }

    @Test
    fun aRefusedActionShowsTheServersWords() {
        rule.setHappyContent { ComputeScreen(loaded(exclusive), ComputeAccess.Manage, ComputePending(), ComputeFailure("No such node."), ComputeActions(), {}) }
        rule.onNodeWithText("That didn't go through").assertExists()
        rule.onNodeWithText("No such node.").assertExists()
    }

    @Test
    fun aLoadFailureHasAnExplicitRetry() {
        var retries = 0
        rule.setHappyContent { ComputeScreen(ComputeSource.State.Failed, ComputeAccess.Use, ComputePending(), null, ComputeActions(onRetry = { retries++ }), {}) }
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun aMemberMayPickOnlyPrivate() {
        var changes = 0
        rule.setHappyContent { ComputerAddScreen(ComputerAdd.open(ComputeAccess.Use)!!, ComputeAccess.Use, { changes++ }, {}, {}) }
        for (mode in listOf(ComputeModeKind.Sandbox, ComputeModeKind.Shared, ComputeModeKind.Exclusive)) rule.onNodeWithTag(ComputeTags.mode(mode)).assertIsNotEnabled()
        rule.onNodeWithTag(ComputeTags.mode(ComputeModeKind.Private)).assertIsEnabled()
        rule.onNodeWithText("Add a computer").assertExists()
        rule.onNodeWithText("Your own computer. Only your agents can join, and you approve each one.").assertExists()
        rule.onNodeWithText("Sandbox, shared and exclusive computers need admin permission. You can add a private computer of your own.").assertExists()
        rule.onNodeWithTag(ComputeTags.mode(ComputeModeKind.Sandbox)).performClick()
        assertEquals(0, changes)
    }

    @Test
    fun aManagerPicksAnyModeAndCreates() {
        var draft = ComputeDraft(ComputeModeKind.Sandbox)
        var creates = 0
        rule.setHappyContent { ComputerAddScreen(ComputerAdd.Choosing(draft), ComputeAccess.Manage, { draft = it(draft) }, { creates++ }, {}) }
        rule.onNodeWithTag(ComputeTags.mode(ComputeModeKind.Exclusive)).performClick()
        assertEquals(ComputeModeKind.Exclusive, draft.mode)
        rule.onNodeWithTag(ComputeTags.CREATE).performScrollTo().performClick()
        assertEquals(1, creates)
    }

    @Test
    fun aRefusedCreateKeepsTheFormWithTheReason() {
        rule.setHappyContent {
            ComputerAddScreen(ComputerAdd.Failed(ComputeDraft(ComputeModeKind.Private, "Laptop"), "Compute nodes are not configured on this deployment."), ComputeAccess.Use, {}, {}, {})
        }
        rule.onNodeWithText("No install command").assertExists()
        rule.onNodeWithText("Compute nodes are not configured on this deployment.").assertExists()
        rule.onNodeWithTag(ComputeTags.NAME).assertTextEquals("Laptop")
    }

    private fun install(mode: ComputeModeKind, commands: ComputeCommands? = ComputeCommands("curl -fsSL https://get.example/install.sh | HAPPY_COMPUTE_MODE='${mode.wire}' sh", "irm https://get.example/install.ps1 | iex"), expiresAt: Long = System.currentTimeMillis() + 3_600_000) =
        ComputerAdd.Shown(ComputeInstall(mode, commands, "jt-secret", "https://acme.happy-clusters.com", expiresAt))

    @Test
    fun aPrivateInstallOffersUnixAndWindowsVerbatimAndCopiesSensitively() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeModeKind.Private), ComputeAccess.Use, {}, {}, {}) }
        rule.onNodeWithText("Run this on your own computer", substring = true).assertExists()
        rule.onNodeWithText("MACOS AND LINUX").assertExists()
        rule.onNodeWithText("WINDOWS (POWERSHELL)").performScrollTo().assertExists()
        rule.onNodeWithTag(ComputeTags.command("unix")).assertTextEquals("curl -fsSL https://get.example/install.sh | HAPPY_COMPUTE_MODE='private' sh")
        rule.onNodeWithTag(ComputeTags.command("windows")).assertTextEquals("irm https://get.example/install.ps1 | iex")
        rule.onAllNodesWithText("Copy")[0].performClick()
        rule.waitForIdle()
        val clipboard = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(android.content.ClipboardManager::class.java)
        assertEquals("curl -fsSL https://get.example/install.sh | HAPPY_COMPUTE_MODE='private' sh", clipboard.primaryClip!!.getItemAt(0).text.toString())
        assertTrue(clipboard.primaryClip!!.description.extras.getBoolean("android.content.extra.IS_SENSITIVE"))
        rule.onNodeWithText("Copied").assertExists()
    }

    @Test
    fun aSandboxInstallIsForLinuxAlone() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeModeKind.Sandbox), ComputeAccess.Manage, {}, {}, {}) }
        rule.onNodeWithText("LINUX").assertExists()
        rule.onAllNodesWithTag(ComputeTags.command("windows")).assertCountEquals(0)
        rule.onNodeWithText("Run this on a Linux computer. Sandbox mode is Linux only.", substring = true).assertExists()
    }

    @Test
    fun anExclusiveInstallIsForLinuxAndMacOSWithoutWindows() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeModeKind.Exclusive), ComputeAccess.Manage, {}, {}, {}) }
        rule.onNodeWithText("MACOS AND LINUX").assertExists()
        rule.onAllNodesWithTag(ComputeTags.command("windows")).assertCountEquals(0)
    }

    @Test
    fun withoutAnInstallerTheServerAndTokenAreShown() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeModeKind.Shared, commands = null), ComputeAccess.Manage, {}, {}, {}) }
        rule.onNodeWithTag(ComputeTags.command("server")).assertTextEquals("https://acme.happy-clusters.com")
        rule.onNodeWithTag(ComputeTags.command("token")).assertTextEquals("jt-secret")
        rule.onAllNodesWithTag(ComputeTags.command("unix")).assertCountEquals(0)
    }

    @Test
    fun anExpiredInstallCannotBeReadOrCopied() {
        rule.setHappyContent { ComputerAddScreen(install(ComputeModeKind.Private, expiresAt = 1), ComputeAccess.Use, {}, {}, {}) }
        rule.onAllNodesWithTag(ComputeTags.command("unix")).assertCountEquals(0)
        rule.onAllNodesWithText("Copy").assertCountEquals(0)
    }

    @Test
    fun editingNeedsANameAndShowsARefusal() {
        rule.setHappyContent {
            ComputerEditScreen(ComputerEdit("n4", "  ", "My own", ComputerEdit.Phase.Failed("description is 1 to 2048 characters.")), {}, {}, {})
        }
        rule.onNodeWithText("Edit computer").assertExists()
        rule.onNodeWithText("Not saved").assertExists()
        rule.onNodeWithText("description is 1 to 2048 characters.").assertExists()
        rule.onNodeWithTag(ComputeTags.DESCRIPTION).assertTextEquals("My own")
        rule.onNodeWithTag(ComputeTags.SAVE).assertIsNotEnabled()
    }
}
