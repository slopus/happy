package com.slopus.happy.ui.home

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeUp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.rigMetadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * useSessionPressHandlers: a finger landing on a session's row reports it
 * (onPressIn, which preloads the chat) before the tap opens it, and the row's
 * tap, long press and swipe behave as before.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SessionPressDownTest {
    @get:Rule
    val rule = createComposeRule()

    private val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val events = mutableListOf<String>()

    private val callbacks = HomeListCallbacks(
        onOpen = { events += "open $it" },
        onMenu = { events += "menu $it" },
        onArchive = { events += "archive $it" },
        onSetArchiveHidden = {},
        onToggleProject = {},
        onOpenMachine = {},
        onCreateWorkspace = {},
        onProjectMenu = { _, _ -> },
        onPressDown = { events += "down $it" },
    )

    private val actions = HomeScreenActions({}, {}, {}, {}, {}, {}, {})

    private fun show(sessions: List<Session>, grouping: SessionListGrouping, machine: com.slopus.happy.model.Machine) {
        val state = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, listOf(machine)), grouping, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        rule.setHappyContent { HomeScreen(state, ConnectionStatus.CONNECTED, grouping, callbacks, actions) }
    }

    private fun flat() = show(
        listOf(session("a", metadata = metadata(path = "/Users/dev/a") { put("machineId", "m1") }, active = true, lastMessageSentAt = noon)),
        SessionListGrouping.Flat,
        machine("m1", machineMetadata { put("displayName", "Studio") }),
    )

    @Test
    fun aTapReportsTheFingerFirstThenOpens() {
        flat()
        rule.node(FlatRowTags.ROW).performTouchInput { down(center) }
        rule.waitForIdle()
        assertEquals(listOf("down a"), events)
        rule.node(FlatRowTags.ROW).performTouchInput { up() }
        rule.waitForIdle()
        assertEquals(listOf("down a", "open a"), events)
    }

    @Test
    fun aLongPressAndASwipeStillWork() {
        flat()
        rule.node(FlatRowTags.ROW).performTouchInput { longClick() }
        rule.waitForIdle()
        assertEquals(listOf("down a", "menu a"), events)
        events.clear()
        rule.node(FlatRowTags.ROW).performTouchInput { swipeLeft() }
        rule.waitForIdle()
        assertEquals("down a", events.first())
        assertEquals(false, "open a" in events)
    }

    @Test
    fun aScrollPastTheRowReportsTheFingerButOpensNothing() {
        flat()
        rule.node(FlatRowTags.ROW).performTouchInput { swipeUp() }
        rule.waitForIdle()
        assertEquals(false, "open a" in events)
    }

    @Test
    fun projectWorktreeAndChatRowsReportTheirSession() {
        val rig = machine("machine-1", machineMetadata { put("displayName", "Studio"); put("machineKind", "rig") })
        show(
            listOf(
                session("own", metadata = rigMetadata(projectId = "p1", projectName = "happy"), lastMessageSentAt = noon),
                session("wt", metadata = rigMetadata(projectId = "p1", projectName = "happy", workspaceId = "w1", workspaceName = "Gdansk"), lastMessageSentAt = noon),
            ),
            SessionListGrouping.Project,
            rig,
        )
        rule.node(ProjectListTags.PROJECT).performTouchInput { down(center); up() }
        rule.node(ProjectListTags.WORKTREE).performTouchInput { down(center); up() }
        rule.waitForIdle()
        assertEquals(listOf("down own", "open own", "down wt", "open wt"), events)
    }
}
