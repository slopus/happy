package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.slopus.happy.model.ProjectWorkspaceGroup
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeScreenActions
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.Activity
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.connection.AgentHomeList
import com.slopus.happy.ui.connection.agentHomeItems
import com.slopus.happy.ui.conversation.activityShimmers
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Which titles shimmer where: desktop's busy rows, the tablet sidebar's, and the chat's working line. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ShimmerPlacesTest {
    @get:Rule
    val rule = createComposeRule()

    private fun conversation(id: String, working: Boolean = false, blocked: Boolean = false, waiting: Boolean = false) =
        AgentFeedRow.Conversation(id, "Chat $id", ConversationKind.Project, depth = 1, working = working, blocked = blocked, waiting = waiting)

    @Test
    fun agentHomeShimmersRunningConversationsAndTheirFolders() {
        val feed = AgentFeed(
            loaded = true,
            rows = listOf(
                AgentFeedRow.Folder("p1", "rig", 0, running = true),
                conversation("a", working = true),
                conversation("b"),
                conversation("c", working = true, blocked = true),
                conversation("d", working = true, waiting = true),
                AgentFeedRow.Folder("p2", "docs", 0),
                conversation("e"),
            ),
        )
        var clock: ShimmerClock? = null
        rule.mainClock.autoAdvance = false
        rule.setHappyContent {
            clock = LocalShimmerClock.current
            AgentHomeList(agentHomeItems(feed), rememberLazyListState(), onOpen = {}, contentPadding = PaddingValues())
        }
        rule.mainClock.advanceTimeByFrame()
        // The running folder and its one running chat; not the question, the wait, or anything idle.
        assertEquals(2, clock!!.sweeping)
    }

    @Test
    fun theChatsWorkingLineShimmersWhileWorkRuns() {
        assertFalse(activityShimmers(null))
        assertFalse("a question waits on the person, still", activityShimmers(Activity.AwaitingAnswer))
        for (activity in Activity.entries - Activity.AwaitingAnswer) assertTrue("$activity", activityShimmers(activity))
    }
}
