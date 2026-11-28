package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.performClick
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.todos.TodoItem
import com.slopus.happy.todos.TodoListState
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.todos.SurfaceList
import com.slopus.happy.ui.todos.SurfaceListEntry
import com.slopus.happy.ui.todos.SurfaceListsContent
import com.slopus.happy.ui.todos.TodoActions
import com.slopus.happy.ui.todos.TodoListContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Home's Documents and TODOs rows on a device, tapped through: home, the
 * Documents page, the TODOs page, and a list opened from it, then Back.
 * The real home, list and todo composables over made-up rows (nothing is
 * anyone's). Shots go to the app's external files under
 * `documents-todos/<screen>.png`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class DocumentsTodosDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "documents-todos").apply { mkdirs() }

    private enum class Page { Home, Documents, Todos, Groceries }

    private val feed = AgentFeed(
        loaded = true,
        rows = listOf(
            AgentFeedRow.Section(AgentFeedSection.Places),
            AgentFeedRow.Feed(2),
            AgentFeedRow.Artifacts,
            AgentFeedRow.Documents,
            AgentFeedRow.Todos,
            AgentFeedRow.Surface("cal", "Team calendar", "calendar"),
            AgentFeedRow.Section(AgentFeedSection.Bots),
            AgentFeedRow.Conversation("bot-1", "Release captain", ConversationKind.Bot, 0, seed = "bot-1"),
            AgentFeedRow.Conversation("bot-2", "Inbox triage", ConversationKind.Bot, 0, seed = "bot-2"),
            AgentFeedRow.Section(AgentFeedSection.Tasks),
            AgentFeedRow.Conversation("task-1", "Fix the login redirect", ConversationKind.Task, 0, seed = "task-1"),
            AgentFeedRow.Conversation("task-2", "Write the release notes", ConversationKind.Task, 0, seed = "task-2"),
        ),
    )
    private val documents = listOf(SurfaceListEntry("d1", "Launch plan"), SurfaceListEntry("d2", "Meeting notes"), SurfaceListEntry("d3", "Onboarding guide"))
    private val todos = listOf(SurfaceListEntry("t1", "Groceries", 3), SurfaceListEntry("t2", "Launch checklist", 5), SurfaceListEntry("t3", "Weekend", 0))
    private val groceries = TodoListState(
        status = TodoListState.Status.Ready,
        active = listOf(TodoItem("g1", "t1", "Milk", orderKey = "a"), TodoItem("g2", "t1", "Eggs", orderKey = "b"), TodoItem("g3", "t1", "Bread", orderKey = "c")),
        completed = listOf(TodoItem("g4", "t1", "Coffee", TodoItem.Status.Completed, completedAt = 1.0)),
    )
    private val noop = TodoActions({}, { _, _ -> }, { _, _ -> }, {}, { _, _, _ -> }, { _, _ -> }, {}, {}, {})

    @Test fun light() = walk(dark = false)

    @Test fun dark() = walk(dark = true)

    private fun walk(dark: Boolean) {
        val theme = if (dark) "dark" else "light"
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            WindowCompat.getInsetsController(rule.activity.window, rule.activity.window.decorView).isAppearanceLightStatusBars = !dark
        }
        rule.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                ProvideWindowLayout {
                    var page by remember { mutableStateOf(Page.Home) }
                    BackHandler(page != Page.Home) { page = if (page == Page.Groceries) Page.Todos else Page.Home }
                    when (page) {
                        Page.Home -> {
                            val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio", agent = true, active = true)))
                            AgentHomeScreen("Studio", feed, AgentLinkStatus.Connected, accounts, AgentHomeActions(
                                {}, {}, {}, {}, {}, {},
                                onOpenDocuments = { page = Page.Documents },
                                onOpenTodos = { page = Page.Todos },
                            ))
                        }
                        Page.Documents -> lists(SurfaceList.Documents, documents) { page = Page.Home }
                        Page.Todos -> lists(SurfaceList.Todos, todos, onOpen = { if (it == "t1") page = Page.Groceries }) { page = Page.Home }
                        Page.Groceries -> PlaceScaffold("Groceries", { page = Page.Todos }, tag = "todo.screen") { TodoListContent(groceries, noop) }
                    }
                }
            }
        }
        capture("home-$theme")
        rule.onNodeWithText("Documents").performClick()
        capture("documents-$theme")
        device.pressBack()
        rule.onNodeWithText("TODOs").performClick()
        capture("todos-$theme")
        rule.onNodeWithText("Groceries").performClick()
        capture("todo-list-opened-$theme")
        device.pressBack()
        capture("todos-after-back-$theme")
    }

    /** The Documents or TODOs page as `SurfaceListsScreen` lays it out, over [entries]. */
    @Composable
    private fun lists(list: SurfaceList, entries: List<SurfaceListEntry>, onOpen: (String) -> Unit = {}, onBack: () -> Unit) {
        PlaceScaffold(stringResource(list.title), onBack, tag = "${list.tag}.screen", actions = {
            BarIconButton(Ionicon.Add, stringResource(list.create), {})
        }) { SurfaceListsContent(list, entries, loaded = true, unsupported = false, onOpen = onOpen, onRefresh = {}) }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        SystemClock.sleep(900)
        device.takeScreenshot(File(dir, "$name.png"))
    }
}
