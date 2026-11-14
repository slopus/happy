package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.ComputeAccess
import com.slopus.happy.agent.ComputeAgent
import com.slopus.happy.agent.ComputeApproval
import com.slopus.happy.agent.ComputeBoundary
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
import com.slopus.happy.ui.connection.ComputeActions
import com.slopus.happy.ui.connection.ComputerActions
import com.slopus.happy.ui.connection.ComputerPending
import com.slopus.happy.ui.connection.ComputerScreen
import com.slopus.happy.ui.connection.ComputePending
import com.slopus.happy.ui.connection.ComputeScreen
import com.slopus.happy.ui.connection.ComputeTags
import com.slopus.happy.ui.connection.ComputerAddScreen
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Emulator-only UI fixture for Settings › Compute. No network, computer, token or mutation; each test writes one screenshot. */
@RunWith(AndroidJUnit4::class)
class ComputeDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private val open = ComputeBoundary(true, null)
    private val computers = listOf(
        Computer("n1", "build-01", ComputeStatus.Online, "build-01.acme.internal", "linux", "x86_64", ComputeAccess.Shared, null, 8, 16,
            listOf(ComputeAgent("a7", "Ship the iOS release"), ComputeAgent("a8", "Fix the flaky checkout test"), ComputeAgent("a9", null)), open,
            "GPU box, CUDA 12.4. Use for training; checkouts under /data.", now),
        Computer("n3", "Mac mini", ComputeStatus.Online, "mini.local", "macos", "arm64", ComputeAccess.Shared, null, 1, null,
            listOf(ComputeAgent("a3", "Profile cold start")),
            ComputeBoundary(false, "macOS has no sandbox for restricted commands yet."), "Xcode 26 and the iPhone 12 on USB.", now),
        Computer("n4", "Steve's laptop", ComputeStatus.Online, "steve-mbp", "macos", "arm64", ComputeAccess.Private, ComputeOwner.Reader, 1, 4,
            emptyList(), open, "My own computer, for my agents.", now),
        Computer("n5", "Ana's desktop", ComputeStatus.Offline, "ana-desk", "linux", "x86_64", ComputeAccess.Private, ComputeOwner.Member("u-ana", "Ana"), 2, null,
            emptyList(), open, null, now - 3 * 3_600_000),
    )
    private val requests = listOf(
        ComputeApproval("n4", "Steve's laptop", "a1", "Fix the flaky checkout test", now - 2 * 60_000),
        ComputeApproval("n4", "Steve's laptop", "a2", "Profile cold start", now - 40 * 60_000),
    )

    private fun shot(name: String, content: @Composable () -> Unit) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { HappyTheme { content() } }
        rule.waitForIdle()
        android.os.SystemClock.sleep(600)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "compute").apply { mkdirs() }
        UiDevice.getInstance(instrumentation).takeScreenshot(File(directory, "$name.png"))
    }

    @Test
    fun list() = shot("compute-list") {
        ComputeScreen(ComputeSource.State.Loaded(ComputeSnapshot(computers, emptyList())), ComputeRole.Manage, ComputePending(), null, ComputeActions(), {})
    }.also {
        rule.onNodeWithText("Full").assertIsDisplayed()
        rule.onNodeWithText("3 of 8 agents").assertIsDisplayed()
    }

    @Test
    fun sharedComputer() = shot("compute-detail-shared") {
        ComputerScreen(ComputeSource.State.Loaded(ComputeSnapshot(computers, emptyList())), "n1", ComputeRole.Manage, ComputerPending(), null, ComputerActions(), {})
    }.also {
        rule.onNodeWithTag(ComputeTags.remove("a7")).assertIsDisplayed()
    }

    @Test
    fun computerWithoutBoundary() = shot("compute-detail-boundary") {
        ComputerScreen(ComputeSource.State.Loaded(ComputeSnapshot(computers, emptyList())), "n3", ComputeRole.Manage, ComputerPending(), null, ComputerActions(), {})
    }.also {
        rule.onNodeWithTag(ComputeTags.BOUNDARY).assertIsDisplayed()
    }

    @Test
    fun joinRequests() = shot("compute-join-requests") {
        ComputeScreen(ComputeSource.State.Loaded(ComputeSnapshot(computers.filter { it.id in setOf("n1", "n4") }, requests)), ComputeRole.Use, ComputePending(), null, ComputeActions(), {})
    }.also {
        rule.onNodeWithTag(ComputeTags.approve("n4/a1")).assertIsDisplayed()
    }

    @Test
    fun managersAddFlow() = shot("compute-add-manager") {
        ComputerAddScreen(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Shared)), ComputeRole.Manage, {}, {}, {})
    }.also {
        rule.onNodeWithTag(ComputeTags.CONCURRENCY).assertIsDisplayed()
    }

    @Test
    fun membersAddFlow() = shot("compute-add-member") {
        ComputerAddScreen(ComputerAdd.Choosing(ComputeDraft(ComputeAccess.Private)), ComputeRole.Use, {}, {}, {})
    }.also {
        rule.onNodeWithTag(ComputeTags.access(ComputeAccess.Shared)).assertIsNotEnabled()
    }

    @Test
    fun privateInstall() = shot("compute-install-private") {
        val token = "eyJhbGciOiJFZERTQSJ9.fixture.not-a-real-token"
        ComputerAddScreen(
            ComputerAdd.Shown(ComputeInstall(
                ComputeAccess.Private, 1,
                ComputeCommands(
                    "curl -fsSL https://get.happy-clusters.com/install.sh | HAPPY_CLUSTER_URL='https://acme.happy-clusters.com' HAPPY_JOIN_TOKEN='$token' sh",
                    "Write-Output 'Happy compute is not available for Windows yet; run the command on Linux (x86_64 or aarch64).'",
                ),
                setOf(ComputeSystem.Linux),
                "macOS and Windows computers are not available yet: Happy compute is published for Linux x86_64 and Linux aarch64 only.",
                token, "https://acme.happy-clusters.com", now + 3_600_000,
            )),
            ComputeRole.Use, {}, {}, {},
        )
    }.also {
        rule.onNodeWithTag(ComputeTags.command("unix")).assertIsDisplayed()
    }
}
