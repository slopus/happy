package com.slopus.happy.ui.tablet

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeListInputs
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.home.HomeSnapshot
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.home.ProjectListTags
import com.slopus.happy.ui.home.deriveHomeList
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The sidebar marks the row of what the main panel shows on a Happy CLI
 * account grouped by project too: a project's own checkout, or the
 * worktree whose chat is open, and nothing else.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SidebarProjectSelectionTest {
    @get:Rule
    val rule = createComposeRule()

    private val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val callbacks = HomeListCallbacks(
        onOpen = {}, onMenu = {}, onArchive = {}, onSetArchiveHidden = {}, onToggleProject = {},
        onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
    )

    private fun show(open: String) {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        val sessions = listOf(
            session("own", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
            session("wt", metadata = rigMetadata(projectId = "p1", projectName = "happy", workspaceId = "w1", workspaceName = "Gdansk"), lastMessageSentAt = noon),
        )
        val state = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, listOf(rig)), SessionListGrouping.Project, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        rule.setHappyContent {
            CompositionLocalProvider(LocalSidebarHome provides SidebarHome(MainPanelKey.session(open))) {
                HomeScreen(state, ConnectionStatus.CONNECTED, SessionListGrouping.Project, callbacks, HomeScreenActions({}, {}, {}, {}, {}, {}))
            }
        }
    }

    private fun card(of: String) = rule.onNode(hasTestTag(HomeTags.CARD_ROW) and hasAnyDescendant(hasTestTag(of)), useUnmergedTree = true)

    private val notSelected = SemanticsMatcher("is not selected") { SemanticsProperties.Selected !in it.config }

    @Test
    fun theProjectsOwnCheckoutIsSelected() {
        show("own")
        card(ProjectListTags.PROJECT).assertIsSelected()
        card(ProjectListTags.WORKTREE).assert(notSelected)
    }

    @Test
    fun theWorktreeWhoseChatIsOpenIsSelected() {
        show("wt")
        card(ProjectListTags.WORKTREE).assertIsSelected()
        card(ProjectListTags.PROJECT).assert(notSelected)
    }
}
