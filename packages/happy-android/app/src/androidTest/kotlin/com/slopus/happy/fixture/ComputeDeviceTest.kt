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
import com.slopus.happy.agent.ComputeApproval
import com.slopus.happy.agent.ComputeCommands
import com.slopus.happy.agent.ComputeDraft
import com.slopus.happy.agent.ComputeHolder
import com.slopus.happy.agent.ComputeInstall
import com.slopus.happy.agent.ComputeMachine
import com.slopus.happy.agent.ComputeMode
import com.slopus.happy.agent.ComputeModeKind
import com.slopus.happy.agent.ComputeOwner
import com.slopus.happy.agent.ComputeSnapshot
import com.slopus.happy.agent.ComputeSource
import com.slopus.happy.agent.ComputeStatus
import com.slopus.happy.agent.MachineAdd
import com.slopus.happy.agent.MachineEdit
import com.slopus.happy.ui.connection.ComputeActions
import com.slopus.happy.ui.connection.ComputePending
import com.slopus.happy.ui.connection.ComputeScreen
import com.slopus.happy.ui.connection.ComputeTags
import com.slopus.happy.ui.connection.MachineAddScreen
import com.slopus.happy.ui.connection.MachineEditScreen
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Emulator-only UI fixture for Settings › Compute. No network, machine, token or mutation; each test writes one screenshot. */
@RunWith(AndroidJUnit4::class)
class ComputeDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private val machines = listOf(
        ComputeMachine("n1", "build-01", ComputeStatus.Online, "build-01.acme.internal", "linux", "x86_64", ComputeMode.Sandbox, "GPU box, CUDA 12.4. Use for training; checkouts under /data.", null, now),
        ComputeMachine("n3", "Mac mini", ComputeStatus.Online, "mini.local", "macos", "arm64", ComputeMode.Exclusive(ComputeHolder("a7", "Ship the iOS release")), "Xcode 26 and the iPhone 12 on USB. One agent at a time.", null, now),
        ComputeMachine("n4", "Steve's laptop", ComputeStatus.Online, "steve-mbp", "macos", "arm64", ComputeMode.Private(ComputeOwner.Reader), "My own machine, for my agents.", null, now),
        ComputeMachine("n2", "Team box", ComputeStatus.Online, "team", "linux", "aarch64", ComputeMode.Shared, "Shared staging host with Docker.", null, now),
        ComputeMachine("n5", "Ana's desktop", ComputeStatus.Offline, "ana-desk", "windows", "x86_64", ComputeMode.Private(ComputeOwner.Member("u-ana", "Ana")), null, null, now - 3 * 3_600_000),
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
    fun listWithEveryMode() = shot("compute-list") {
        ComputeScreen(ComputeSource.State.Loaded(ComputeSnapshot(machines, emptyList())), ComputeAccess.Manage, ComputePending(), null, ComputeActions(), {})
    }.also {
        rule.onNodeWithText("In use").assertIsDisplayed()
        rule.onNodeWithText("Yours").assertIsDisplayed()
    }

    @Test
    fun joinRequests() = shot("compute-join-requests") {
        ComputeScreen(ComputeSource.State.Loaded(ComputeSnapshot(machines.filter { it.id in setOf("n1", "n4") }, requests)), ComputeAccess.Use, ComputePending(), null, ComputeActions(), {})
    }.also {
        rule.onNodeWithTag(ComputeTags.approve("n4/a1")).assertIsDisplayed()
    }

    @Test
    fun membersAddFlow() = shot("compute-add-member") {
        MachineAddScreen(MachineAdd.Choosing(ComputeDraft(ComputeModeKind.Private, "Steve's laptop", "My own machine, for my agents.")), ComputeAccess.Use, {}, {}, {})
    }.also {
        rule.onNodeWithTag(ComputeTags.mode(ComputeModeKind.Sandbox)).assertIsNotEnabled()
    }

    @Test
    fun privateInstall() = shot("compute-install-private") {
        val token = "eyJhbGciOiJFZERTQSJ9.fixture.not-a-real-token"
        MachineAddScreen(
            MachineAdd.Shown(ComputeInstall(
                ComputeModeKind.Private,
                ComputeCommands(
                    "curl -fsSL https://get.happy-clusters.com/install.sh | HAPPY_CLUSTER_URL='https://acme.happy-clusters.com' HAPPY_JOIN_TOKEN='$token' HAPPY_COMPUTE_MODE='private' sh",
                    "\$env:HAPPY_CLUSTER_URL='https://acme.happy-clusters.com'; \$env:HAPPY_JOIN_TOKEN='$token'; \$env:HAPPY_COMPUTE_MODE='private'; irm https://get.happy-clusters.com/install.ps1 | iex",
                ),
                token, "https://acme.happy-clusters.com", now + 3_600_000,
            )),
            ComputeAccess.Use, {}, {}, {},
        )
    }.also {
        rule.onNodeWithTag(ComputeTags.command("unix")).assertIsDisplayed()
    }

    @Test
    fun edit() = shot("compute-edit") {
        MachineEditScreen(MachineEdit("n1", "build-01", "GPU box, CUDA 12.4. Use for training; checkouts under /data."), {}, {}, {})
    }.also {
        rule.onNodeWithTag(ComputeTags.SAVE).assertIsDisplayed()
    }
}
