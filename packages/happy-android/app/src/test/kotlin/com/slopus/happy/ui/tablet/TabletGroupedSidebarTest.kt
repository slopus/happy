package com.slopus.happy.ui.tablet

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeServices
import com.slopus.happy.ui.home.NewSessionTags
import com.slopus.happy.ui.home.ProjectListTags
import com.slopus.happy.ui.node
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * MainView.tsx's sidebar mounts SessionsList, so "Group by project" shows
 * SessionsList's own hierarchy there, not home's project cards.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletGroupedSidebarTest {
    @get:Rule
    val rule = createComposeRule()

    private val server = FakeHappyServer().start()
    private lateinit var graph: AppGraph

    @After
    fun tearDown() = server.close()

    private fun session(id: String, path: String) = server.addSession(
        id,
        updatedAt = 100,
        metadata = buildJsonObject {
            put("path", path)
            put("host", "devbox")
            put("machineId", "m1")
            put("summary", buildJsonObject { put("text", "Chat $id"); put("updatedAt", 1) })
        },
    )

    private fun waitFor(tag: String) = rule.waitUntilAtLeastOneExists(hasTestTag(tag), 5_000)

    @Test
    fun groupedByProjectTheSidebarShowsCheckoutsWithCompactRows() {
        server.addMachine("m1")
        session("a", "/repo/one")
        session("b", "/repo/one")
        session("c", "/repo/two")
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = server.url,
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        runBlocking { graph.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))) }
        graph.settings.change { it.copy(sessionListGrouping = SessionListGrouping.Project) }
        rule.setContent { HappyApp(graph) }

        waitFor(TabletGroupedTags.COMPACT_ROW)
        rule.onAllNodesWithTag(TabletGroupedTags.MACHINE, useUnmergedTree = true).assertCountEquals(1)
        rule.onAllNodesWithTag(TabletGroupedTags.CHECKOUT, useUnmergedTree = true).assertCountEquals(2)
        rule.onAllNodesWithTag(TabletGroupedTags.COMPACT_ROW, useUnmergedTree = true).assertCountEquals(3)
        // Not home's cards, nor the flat rows.
        rule.onAllNodesWithTag(ProjectListTags.MACHINE, useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(FlatRowTags.ROW, useUnmergedTree = true).assertCountEquals(0)

        rule.onAllNodesWithTag(TabletGroupedTags.COMPACT_ROW, useUnmergedTree = true)[0].performClick()
        waitFor(ChatScreenTags.SCREEN)
        rule.onAllNodesWithTag(TabletGroupedTags.COMPACT_ROW, useUnmergedTree = true)[0].assertIsSelected()

        // The "+" points the draft at that checkout and opens the new-session screen beside the list.
        rule.onAllNodesWithTag(TabletGroupedTags.ADD, useUnmergedTree = true)[1].performClick()
        waitFor(NewSessionTags.SCREEN)
        val draft = HomeServices.of(graph)
            .newSession(ApplicationProvider.getApplicationContext()).draft.value
        assertEquals("m1", draft.selectedMachineId)
        assertEquals("/repo/two", draft.selectedPath)
        rule.node(TabletGroupedTags.LIST).assertExists()
    }
}
