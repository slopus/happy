package com.slopus.happy.fixture

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.ui.files.FileLoad
import com.slopus.happy.ui.files.FileScreen
import com.slopus.happy.ui.files.FileTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** File-viewer tab contrast and switching on real Compose, in the requested window and theme. */
@RunWith(AndroidJUnit4::class)
class FileViewerDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun renderedAndSourceTabs() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val dark = InstrumentationRegistry.getArguments().getString("dark") == "true"
        val name = InstrumentationRegistry.getArguments().getString("shot") ?: "file"
        val app = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        rule.activityRule.scenario.onActivity { it.enableEdgeToEdge() }
        rule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        rule.setContent {
            HappyTheme(preference = if (dark) ThemePreference.Dark else ThemePreference.Light) {
                ProvideWindowLayout {
                    FileScreen(FileLoad.Loaded("# Release notes\n\nThe file opens as a document. Switch to Source to read its Markdown.", null), "docs/README.md", onBack = {})
                }
            }
        }
        rule.waitUntil(10_000) { rule.onAllNodesWithText("Release notes", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag(FileTags.RENDERED_TAB, useUnmergedTree = true).assertIsSelected()
        val evidence = File(app.filesDir, "device-evidence/files").apply { mkdirs() }
        device.waitForIdle()
        assertTrue(device.takeScreenshot(File(evidence, "$name-rendered.png")))
        rule.onNodeWithTag(FileTags.FILE_TAB, useUnmergedTree = true).performClick().assertIsSelected()
        device.waitForIdle()
        assertTrue(device.takeScreenshot(File(evidence, "$name-source.png")))
    }
}