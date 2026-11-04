package com.slopus.happy.ui.monitor

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.monitor.ProcessTable
import com.slopus.happy.monitor.SystemMonitorFeed
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.cards.CardHeading
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.connection.AgentSearchField
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext

/**
 * iOS MonitorViewController: grouped machine/resource readings then processes.
 * Search and sort live in the bar, so changing samples only replaces the
 * affected lazy rows. The process order holds for five seconds while its
 * readings keep changing. Missing samples stay absent, never become zero.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@Composable
internal fun MonitorScreen(state: SystemMonitorFeed.State, name: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    var searching by rememberSaveable { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf("") }
    var column by rememberSaveable { mutableStateOf(ProcessTable.Column.Cpu) }
    var descending by rememberSaveable { mutableStateOf(true) }
    val sort = ProcessTable.Sort(column, descending)
    val focus = LocalFocusManager.current
    val closeSearch = { focus.clearFocus(); searching = false; filter = "" }
    BackHandler(searching, closeSearch)
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val words = remember(context, configuration) { context.createConfigurationContext(configuration).resources }
    val dark = HappyTheme.colors.dark
    val table = remember { ProcessTable() }
    val deriver = remember { Dispatchers.Default.limitedParallelism(1) }
    val rows by produceState(emptyList<MonitorRow>(), state, filter, sort, words, dark) {
        value = withContext(deriver) { monitorRows(state, filter, sort, table, words, dark) }
    }
    val list = rememberLazyListState()
    val reduced = rememberReduceMotion()
    LaunchedEffect(searching) {
        if (searching) {
            val index = rows.indexOfFirst { it.key == "processes" }
            if (index >= 0) { if (reduced) list.scrollToItem(index) else list.animateScrollToItem(index) }
        }
    }
    val searchLabel = stringResource(R.string.monitor_filter)
    val chooseSort = { next: ProcessTable.Sort -> column = next.column; descending = next.descending }
    PlaceScaffold(name, onBack, tag = "monitor.screen", actions = {
        BarIconButton(Ionicon.SearchOutline, searchLabel, { searching = true }, Modifier.testTag("monitor.search"))
        MonitorSortMenu(sort, chooseSort)
        actions()
    }, bar = if (!searching) null else {
        {
            AgentTopBar(tag = "monitor.search.bar", container = HappyTheme.colors.surface,
                navigationIcon = { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), closeSearch) },
                title = { AgentSearchField(filter, { filter = it }, placeholder = searchLabel) },
                actions = {
                    if (filter.isNotEmpty()) BarIconButton(Ionicon.Close, stringResource(R.string.agent_search_clear), { filter = "" }, Modifier.testTag("monitor.search.clear"))
                    MonitorSortMenu(sort, chooseSort)
                })
        }
    }) { MonitorContent(rows, list) }
}

@Composable
private fun MonitorSortMenu(sort: ProcessTable.Sort, onSort: (ProcessTable.Sort) -> Unit) {
    var choosing by remember { mutableStateOf(false) }
    Box {
        val description = "${stringResource(R.string.monitor_sort)}: ${stringResource(monitorColumn(sort.column))} ${if (sort.descending) "↓" else "↑"}"
        BarIconButton(Ionicon.Filter, description, { choosing = true }, Modifier.testTag("monitor.sort"))
        TrackOverlay(choosing) { choosing = false }
        DropdownMenu(choosing, { choosing = false }) {
            ProcessTable.Column.entries.forEach { item ->
                val selected = sort.column == item
                val label = stringResource(monitorColumn(item)) + if (selected) if (sort.descending) " ↓" else " ↑" else ""
                DropdownMenuItem(text = { Text(label) }, onClick = { onSort(sort.choosing(item)); choosing = false }, modifier = Modifier.testTag("monitor.sort.${item.name}"))
            }
        }
    }
}

internal fun monitorColumn(column: ProcessTable.Column): Int = when (column) {
    ProcessTable.Column.Pid -> R.string.monitor_pid
    ProcessTable.Column.Name -> R.string.settings_account_name
    ProcessTable.Column.User -> R.string.monitor_user
    ProcessTable.Column.Cpu -> R.string.monitor_cpu
    ProcessTable.Column.Memory -> R.string.monitor_memory
    ProcessTable.Column.State -> R.string.monitor_state
    ProcessTable.Column.Threads -> R.string.monitor_threads
}

@Composable
internal fun MonitorContent(rows: List<MonitorRow>, list: LazyListState = rememberLazyListState()) {
    LazyColumn(Modifier.fillMaxSize().imePadding().navigationBarsPadding().testTag("monitor.rows"), state = list, contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
        items(rows, key = { it.key }, contentType = { it::class }) { row ->
            when (row) {
                is MonitorRow.Heading -> CardHeading(row.text, afterCard = row.key != "overview", trailing = row.trailing)
                is MonitorRow.Gap -> Spacer(Modifier.height(14.dp))
                is MonitorRow.Host -> MonitorHost(row.title, row.meta, row.status, row.description, row.live, row.loading)
                is MonitorRow.Summary -> MonitorSummary(row.key, HomeCardPlace(true, false), row.title, row.value, row.subtitle, row.icon, row.tint, row.lines, row.bars)
                is MonitorRow.Detail -> MonitorDetail(row.key, HomeCardPlace(row.alone, row.last), row.label, row.value, row.meter, row.percent, row.note, row.dot, row.quiet)
                is MonitorRow.Process -> MonitorProcess(row.pid, HomeCardPlace(row.first, row.last), row.name, row.cpu, row.memory, row.meta, row.history, row.level, row.description)
                is MonitorRow.Note -> Text(row.text, style = happyTextStyle(13, 18), color = HappyTheme.colors.textSecondary,
                    modifier = Modifier.contentMaxWidth(LocalWindowLayout.current).padding(horizontal = 32.dp, vertical = if (row.key == "footer") 16.dp else if (row.key == "unavailable") 24.dp else 10.dp).testTag("monitor.note.${row.key}"))
            }
        }
    }
}